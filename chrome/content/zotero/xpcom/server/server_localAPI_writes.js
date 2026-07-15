/*
	***** BEGIN LICENSE BLOCK *****

	Copyright © 2026 eejd

	This file is part of the zotero native-split fork (branch local-api-writes).

	Zotero is free software: you can redistribute it and/or modify
	it under the terms of the GNU Affero General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.

	Zotero is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
	GNU Affero General Public License for more details.

	You should have received a copy of the GNU Affero General Public License
	along with Zotero.  If not, see <http://www.gnu.org/licenses/>.

	***** END LICENSE BLOCK *****
*/

/*

Write support for the local API (contract Phase 2; eejd/zotero-api-contract ADR-0015).

Everything lives in this one file so the fork stays trivially rebase-able on upstream --
the only upstream edits are the loader line in zotero.mjs, the base-class export at the
bottom of server_localAPI.js, and DELETE/PATCH method dispatch in server.js.

Endpoints added (all under /api/, same routing conventions as server_localAPI.js):

- POST   <lib>/items                                 create/update up to 100 items
- DELETE <lib>/items?itemKey=K1,K2                   delete items
- PATCH  <lib>/items/:itemKey                        partial update
- POST   <lib>/collections                           create/update up to 100 collections
- DELETE <lib>/collections?collectionKey=K1,K2       delete collections
- POST   <lib>/searches                              create/update up to 100 saved searches
- DELETE <lib>/searches?searchKey=K1,K2              delete saved searches
- GET    <lib>/settings                              return synced settings with metadata
- POST   <lib>/settings                              create/update synced settings
- DELETE <lib>/settings?settingKey=K1,K2             delete synced settings
- POST   <lib>/capture                               thin capture: translate captured HTML
                                                     server-side, webpage-item fallback
- POST   <lib>/items/:itemKey/file                   upload dance: authorize / register
- POST   <lib>/items/:itemKey/file/upload/:uploadKey upload dance: raw bytes (local-only)

Version semantics: local writes follow UI-edit semantics -- objects are saved as unsynced
and the sync engine uploads them on the next sync; neither object versions nor the library
version are bumped locally (bumping libraryVersion would desynchronize the sync engine's
notion of server state). If-Unmodified-Since-Version is honored (412 when the given version
is older than the current library version) and per-object `version` mismatches fail the
individual object with a 412 entry, which matches web-API behavior on synced libraries and
degrades to always-pass on never-synced ones (libraryVersion 0).

*/

var { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");

const CAPTURE_IDEMPOTENCY_LIMIT = 100;
const UPLOAD_KEY_TTL = 60 * 60 * 1000;

Zotero.Server.LocalAPI.Writes = {
	// clientKey -> [status, headers, body] of the original capture response
	_captureResults: new Map(),
	// uploadKey -> { itemID, md5, filename, filesize, mtime, created }
	_pendingUploads: new Map(),
};

class LocalAPIWritesError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

/**
 * Shared helpers for write endpoints. Mixed into subclasses of the (GET-only) upstream
 * endpoint classes, which they extend so existing GET behavior is inherited unchanged.
 */
const WriteHelpers = {
	apiURL() {
		return `http://localhost:${Zotero.Server.port}/api/`;
	},

	/**
	 * Throw 412 if If-Unmodified-Since-Version is present and older than the current
	 * library version.
	 */
	checkLibraryPrecondition(requestData) {
		let header = requestData.headers.get('If-Unmodified-Since-Version');
		if (header === null) {
			return;
		}
		let version = parseInt(header);
		if (Number.isNaN(version)) {
			throw new LocalAPIWritesError(400, `Invalid 'If-Unmodified-Since-Version' value '${header}'`);
		}
		let libraryVersion = Zotero.Libraries.get(requestData.libraryID).libraryVersion;
		if (version < libraryVersion) {
			throw new LocalAPIWritesError(412, `Library has been modified since specified version (expected ${version}, found ${libraryVersion})`);
		}
	},

	checkEditable(requestData) {
		if (!Zotero.Libraries.get(requestData.libraryID).editable) {
			throw new LocalAPIWritesError(403, 'Library is not editable');
		}
	},

	async toWriteEnvelope(dataObject) {
		return dataObject.toResponseJSONAsync
			? dataObject.toResponseJSONAsync({ apiURL: this.apiURL(), includeGroupDetails: true })
			: dataObject;
	},

	async makeWriteResultResponse(requestData, status, saved, failed, unchanged = {}) {
		let result = {
			successful: {},
			success: {},
			unchanged,
			failed,
		};
		for (let [index, object] of saved) {
			result.successful[String(index)] = await this.toWriteEnvelope(object);
			result.success[String(index)] = object.key;
		}
		return this.makeResponse(
			status,
			{
				'Content-Type': 'application/json',
				'Last-Modified-Version': Zotero.Libraries.get(requestData.libraryID).libraryVersion,
			},
			JSON.stringify(result, null, 4)
		);
	},

	/**
	 * Create/update a batch of data objects from JSON (web-API multi-object write).
	 *
	 * @param {Object} requestData
	 * @param {Object} spec - { plural: Zotero.Items, singularName: 'item', make: json => Zotero.DataObject }
	 */
	async runBatchWrite(requestData, spec) {
		let data = requestData.data;
		if (!Array.isArray(data)) {
			return this.makeResponse(400, 'text/plain', 'POST body must be a JSON array');
		}
		if (data.length > 100) {
			return this.makeResponse(413, 'text/plain', 'Too many objects in one request (max 100)');
		}
		this.checkEditable(requestData);
		this.checkLibraryPrecondition(requestData);

		let libraryID = requestData.libraryID;
		let saved = [];
		let failed = {};
		await Zotero.DB.executeTransaction(async () => {
			for (let i = 0; i < data.length; i++) {
				let json = data[i];
				try {
					if (!json || typeof json != 'object') {
						throw new LocalAPIWritesError(400, 'Invalid object');
					}
					let object = json.key
						? spec.plural.getByLibraryAndKey(libraryID, json.key)
						: null;
					if (object) {
						if (json.version !== undefined && json.version !== object.version) {
							throw new LocalAPIWritesError(412, `${spec.singularName} ${json.key} has been modified since specified version (expected ${json.version}, found ${object.version})`);
						}
					}
					else {
						object = spec.make(json);
						object.libraryID = libraryID;
						if (json.key) {
							object.key = json.key;
							await object.loadPrimaryData();
						}
					}
					object.fromJSON(json);
					await object.save();
					saved.push([i, object]);
				}
				catch (e) {
					if (!(e instanceof LocalAPIWritesError)) {
						Zotero.logError(e);
					}
					failed[String(i)] = {
						code: e instanceof LocalAPIWritesError ? e.status : 400,
						message: e.message,
					};
				}
			}
		});
		return this.makeWriteResultResponse(requestData, 200, saved, failed);
	},

	/**
	 * Delete objects selected by a comma-separated key query parameter.
	 */
	async runBatchDelete(requestData, spec) {
		this.checkEditable(requestData);
		this.checkLibraryPrecondition(requestData);
		let keysParam = requestData.searchParams.get(spec.keyParam);
		if (!keysParam) {
			return this.makeResponse(400, 'text/plain', `'${spec.keyParam}' query parameter is required`);
		}
		let keys = keysParam.split(',').filter(Boolean);
		if (keys.length > 100) {
			return this.makeResponse(413, 'text/plain', 'Too many objects in one request (max 100)');
		}
		let libraryID = requestData.libraryID;
		let objects = keys
			.map(key => spec.plural.getByLibraryAndKey(libraryID, key))
			.filter(Boolean);
		await Zotero.DB.executeTransaction(async () => {
			for (let object of objects) {
				await object.erase();
			}
		});
		return this.makeResponse(204, 'text/plain', '');
	},
};

/**
 * Wrap run() so LocalAPIWritesError becomes a plain HTTP response.
 */
function writeEndpoint(cls) {
	let run = cls.prototype.run;
	cls.prototype.run = async function (requestData) {
		try {
			return await run.call(this, requestData);
		}
		catch (e) {
			if (e instanceof LocalAPIWritesError) {
				return this.makeResponse(e.status, 'text/plain', e.message);
			}
			throw e;
		}
	};
	Object.assign(cls.prototype, WriteHelpers);
	return cls;
}


Zotero.Server.LocalAPI.ItemsWrite = writeEndpoint(class extends Zotero.Server.LocalAPI.Items {
	supportedMethods = ['GET', 'POST', 'DELETE'];
	supportedDataTypes = ['application/json'];

	async run(requestData) {
		if (requestData.method == 'POST') {
			return this.runBatchWrite(requestData, {
				plural: Zotero.Items,
				singularName: 'Item',
				make: (json) => {
					if (!json.itemType) {
						throw new LocalAPIWritesError(400, "'itemType' property not provided");
					}
					if (!Zotero.ItemTypes.getID(json.itemType)) {
						throw new LocalAPIWritesError(400, `Invalid item type '${json.itemType}'`);
					}
					return new Zotero.Item(json.itemType);
				},
			});
		}
		if (requestData.method == 'DELETE') {
			return this.runBatchDelete(requestData, { plural: Zotero.Items, keyParam: 'itemKey' });
		}
		return super.run(requestData);
	}
});
Zotero.Server.Endpoints["/api/users/:userID/items"] = Zotero.Server.LocalAPI.ItemsWrite;
Zotero.Server.Endpoints["/api/groups/:groupID/items"] = Zotero.Server.LocalAPI.ItemsWrite;


Zotero.Server.LocalAPI.ItemWrite = writeEndpoint(class extends Zotero.Server.LocalAPI.Item {
	supportedMethods = ['GET', 'PATCH'];
	supportedDataTypes = ['application/json'];

	async run(requestData) {
		if (requestData.method != 'PATCH') {
			return super.run(requestData);
		}
		this.checkEditable(requestData);
		let { pathParams, libraryID, data } = requestData;
		let item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, pathParams.itemKey);
		if (!item) {
			return this.makeResponse(404, 'text/plain', 'Not found');
		}
		this.checkLibraryPrecondition(requestData);
		if (data && data.version !== undefined && data.version !== item.version) {
			return this.makeResponse(412, 'text/plain', `Item ${item.key} has been modified since specified version (expected ${data.version}, found ${item.version})`);
		}
		if (!data || typeof data != 'object' || Array.isArray(data)) {
			return this.makeResponse(400, 'text/plain', 'PATCH body must be a JSON object');
		}
		// Merge-patch: unlisted fields are preserved (dataserver PATCH semantics)
		let merged = Object.assign(item.toJSON(), data, { key: item.key, version: item.version });
		item.fromJSON(merged);
		await item.saveTx();
		return this.makeResponse(204, 'text/plain', '');
	}
});
Zotero.Server.Endpoints["/api/users/:userID/items/:itemKey"] = Zotero.Server.LocalAPI.ItemWrite;
Zotero.Server.Endpoints["/api/groups/:groupID/items/:itemKey"] = Zotero.Server.LocalAPI.ItemWrite;


Zotero.Server.LocalAPI.CollectionsWrite = writeEndpoint(class extends Zotero.Server.LocalAPI.Collections {
	supportedMethods = ['GET', 'POST', 'DELETE'];
	supportedDataTypes = ['application/json'];

	async run(requestData) {
		if (requestData.method == 'POST') {
			return this.runBatchWrite(requestData, {
				plural: Zotero.Collections,
				singularName: 'Collection',
				make: (json) => {
					if (!json.name) {
						throw new LocalAPIWritesError(400, "'name' property not provided");
					}
					return new Zotero.Collection();
				},
			});
		}
		if (requestData.method == 'DELETE') {
			return this.runBatchDelete(requestData, { plural: Zotero.Collections, keyParam: 'collectionKey' });
		}
		return super.run(requestData);
	}
});
Zotero.Server.Endpoints["/api/users/:userID/collections"] = Zotero.Server.LocalAPI.CollectionsWrite;
Zotero.Server.Endpoints["/api/groups/:groupID/collections"] = Zotero.Server.LocalAPI.CollectionsWrite;


Zotero.Server.LocalAPI.SearchesWrite = writeEndpoint(class extends Zotero.Server.LocalAPI.Searches {
	supportedMethods = ['GET', 'POST', 'DELETE'];
	supportedDataTypes = ['application/json'];

	async run(requestData) {
		if (requestData.method == 'POST') {
			return this.runBatchWrite(requestData, {
				plural: Zotero.Searches,
				singularName: 'Search',
				make: (json) => {
					if (!json.name) {
						throw new LocalAPIWritesError(400, "'name' property not provided");
					}
					if (!Array.isArray(json.conditions)) {
						throw new LocalAPIWritesError(400, "'conditions' property must be an array");
					}
					return new Zotero.Search();
				},
			});
		}
		if (requestData.method == 'DELETE') {
			return this.runBatchDelete(requestData, {
				plural: Zotero.Searches,
				keyParam: 'searchKey',
			});
		}
		return super.run(requestData);
	}
});
Zotero.Server.Endpoints["/api/users/:userID/searches"] = Zotero.Server.LocalAPI.SearchesWrite;
Zotero.Server.Endpoints["/api/groups/:groupID/searches"] = Zotero.Server.LocalAPI.SearchesWrite;


Zotero.Server.LocalAPI.SettingsWrite = writeEndpoint(class extends Zotero.Server.LocalAPI.Settings {
	supportedMethods = ['GET', 'POST', 'DELETE'];
	supportedDataTypes = ['application/json'];

	async run(requestData) {
		if (requestData.method == 'GET') {
			let libraryVersion = Zotero.Libraries.get(requestData.libraryID).libraryVersion;
			let header = requestData.headers.get('If-Modified-Since-Version');
			if (header !== null) {
				let version = parseInt(header);
				if (Number.isNaN(version)) {
					return this.makeResponse(400, 'text/plain', `Invalid 'If-Modified-Since-Version' value '${header}'`);
				}
				if (version >= libraryVersion) {
					return this.makeResponse(304, 'text/plain', '');
				}
			}
			let rows = await Zotero.DB.queryAsync(
				"SELECT setting, value, version FROM syncedSettings WHERE libraryID=?",
				requestData.libraryID
			);
			let settings = {};
			for (let row of rows) {
				settings[row.setting] = {
					value: JSON.parse(row.value),
					version: row.version,
				};
			}
			return this.makeResponse(200, {
				'Content-Type': 'application/json',
				'Last-Modified-Version': libraryVersion,
			}, JSON.stringify(settings, null, 4));
		}

		this.checkEditable(requestData);
		this.checkLibraryPrecondition(requestData);
		if (requestData.method == 'POST') {
			let data = requestData.data;
			if (!data || typeof data != 'object' || Array.isArray(data)) {
				return this.makeResponse(400, 'text/plain', 'POST body must be a JSON object');
			}
			let entries = Object.entries(data);
			if (entries.length > 100) {
				return this.makeResponse(413, 'text/plain', 'Too many settings in one request (max 100)');
			}
			let failed = {};
			for (let [key, wrapper] of entries) {
				try {
					if (!wrapper || typeof wrapper != 'object' || Array.isArray(wrapper)
						|| !Object.prototype.hasOwnProperty.call(wrapper, 'value')) {
						throw new LocalAPIWritesError(400, "Setting must contain a 'value' property");
					}
					await Zotero.SyncedSettings.set(requestData.libraryID, key, wrapper.value);
				}
				catch (e) {
					if (!(e instanceof LocalAPIWritesError)) Zotero.logError(e);
					failed[key] = {
						code: e instanceof LocalAPIWritesError ? e.status : 400,
						message: e.message,
					};
				}
			}
			if (Object.keys(failed).length) {
				return this.makeResponse(200, 'application/json', JSON.stringify({ failed }, null, 4));
			}
			return this.makeResponse(204, 'text/plain', '');
		}

		let keysParam = requestData.searchParams.get('settingKey');
		if (!keysParam) {
			return this.makeResponse(400, 'text/plain', "'settingKey' query parameter is required");
		}
		let keys = keysParam.split(',').filter(Boolean);
		if (keys.length > 100) {
			return this.makeResponse(413, 'text/plain', 'Too many settings in one request (max 100)');
		}
		for (let key of keys) {
			if (Zotero.SyncedSettings.get(requestData.libraryID, key) !== null) {
				await Zotero.SyncedSettings.clear(requestData.libraryID, key);
			}
		}
		return this.makeResponse(204, 'text/plain', '');
	}
});
Zotero.Server.Endpoints["/api/users/:userID/settings"] = Zotero.Server.LocalAPI.SettingsWrite;
Zotero.Server.Endpoints["/api/groups/:groupID/settings"] = Zotero.Server.LocalAPI.SettingsWrite;


/**
 * Thin capture (contract ADR-0014/ADR-0015): the client sends the URL and page HTML the
 * user actually saw; translation runs here, replaying the captured HTML through the
 * translator framework (same recipe as the connector's Detect/SaveItems path). When no
 * translator matches -- or `translate` is false, or no HTML was captured -- an untranslated
 * `webpage` item is saved instead, so the save never fails for lack of a translator.
 */
Zotero.Server.LocalAPI.Capture = writeEndpoint(class extends Zotero.Server.LocalAPI.Endpoint {
	supportedMethods = ['POST'];
	supportedDataTypes = ['application/json'];

	async run(requestData) {
		let data = requestData.data;
		if (!data || typeof data != 'object' || Array.isArray(data)) {
			return this.makeResponse(400, 'text/plain', 'POST body must be a JSON object');
		}
		let {
			url,
			title,
			html,
			translate: doTranslate = true,
			saveSnapshot = true,
			collections = [],
			tags = [],
			note,
			accessDate,
			clientKey,
		} = data;
		if (!url || typeof url != 'string') {
			return this.makeResponse(400, 'text/plain', "'url' property not provided");
		}
		this.checkEditable(requestData);

		// Idempotent replay: a clientKey we have already processed returns the original
		// result with a 200 instead of creating a duplicate -- but only while the created
		// item still exists; once it has been deleted, the same clientKey creates fresh
		let seen = Zotero.Server.LocalAPI.Writes._captureResults;
		if (clientKey && seen.has(clientKey)) {
			let cached = seen.get(clientKey);
			if (Zotero.Items.getByLibraryAndKey(cached.libraryID, cached.itemKey)) {
				let [, headers, body] = cached.response;
				return this.makeResponse(200, { ...headers }, body);
			}
			seen.delete(clientKey);
		}

		let libraryID = requestData.libraryID;
		let collectionIDs = collections
			.map(key => Zotero.Collections.getIDFromLibraryAndKey(libraryID, key))
			.filter(Boolean);

		let items = [];
		if (doTranslate && html) {
			items = await this._translateCapturedHTML(html, url, libraryID, collectionIDs);
		}
		if (!items.length) {
			items = [await this._saveWebpageItem(libraryID, collectionIDs, url, title, html, accessDate)];
		}

		let primary = items[0];
		for (let tag of tags) {
			let name = typeof tag == 'string' ? tag : tag && tag.tag;
			if (name) {
				primary.addTag(name);
			}
		}
		if (tags.length) {
			await primary.saveTx();
		}
		if (note && typeof note == 'string') {
			let noteItem = new Zotero.Item('note');
			noteItem.libraryID = libraryID;
			noteItem.parentItemID = primary.id;
			noteItem.setNote(note);
			await noteItem.saveTx();
		}
		if (saveSnapshot && html) {
			try {
				await Zotero.Attachments.importFromSnapshotContent({
					url,
					snapshotContent: html,
					parentItemID: primary.id,
					title: title || undefined,
				});
			}
			catch (e) {
				// A failed snapshot must not fail the save
				Zotero.logError(e);
			}
		}

		let response = await this.makeWriteResultResponse(
			requestData,
			201,
			items.map((item, i) => [i, item]),
			{}
		);
		if (clientKey) {
			if (seen.size >= CAPTURE_IDEMPOTENCY_LIMIT) {
				seen.delete(seen.keys().next().value);
			}
			seen.set(clientKey, { libraryID, itemKey: primary.key, response });
		}
		return response;
	}

	async _translateCapturedHTML(html, url, libraryID, collectionIDs) {
		try {
			let parser = new DOMParser();
			let doc = parser.parseFromString(html, 'text/html');
			doc = Zotero.HTTP.wrapDocument(doc, url);
			let translate = new Zotero.Translate.Web();
			translate.setDocument(doc);
			let translators = await translate.getTranslators();
			if (!translators.length) {
				return [];
			}
			translate.setTranslator(translators[0]);
			let items = await translate.translate({
				libraryID,
				collections: collectionIDs.length ? collectionIDs : null,
				saveOptions: { skipSelect: true },
			});
			return items || [];
		}
		catch (e) {
			// Translation failure falls back to the webpage item
			Zotero.debug(`Capture translation failed for ${url}: ${e.message}`);
			return [];
		}
	}

	async _saveWebpageItem(libraryID, collectionIDs, url, title, html, accessDate) {
		let item = new Zotero.Item('webpage');
		item.libraryID = libraryID;
		if (!title && html) {
			let doc = new DOMParser().parseFromString(html, 'text/html');
			title = doc.title;
		}
		item.setField('title', title || url);
		item.setField('url', url);
		let accessDateSQL = 'CURRENT_TIMESTAMP';
		if (accessDate) {
			let sql = Zotero.Date.isoToSQL(accessDate);
			if (sql) {
				accessDateSQL = sql;
			}
		}
		item.setField('accessDate', accessDateSQL);
		if (collectionIDs.length) {
			item.setCollections(collectionIDs);
		}
		await item.saveTx();
		return item;
	}
});
Zotero.Server.Endpoints["/api/users/:userID/capture"] = Zotero.Server.LocalAPI.Capture;
Zotero.Server.Endpoints["/api/groups/:groupID/capture"] = Zotero.Server.LocalAPI.Capture;


/**
 * File-upload dance, phases 1 (authorize) and 3 (register). Web-API-faithful: one path,
 * the form body's fields select the phase (ADR-0015). The upload URL returned by authorize
 * points at the local raw-bytes endpoint below.
 */
Zotero.Server.LocalAPI.ItemFileWrite = writeEndpoint(class extends Zotero.Server.LocalAPI.ItemFile {
	supportedMethods = ['GET', 'POST'];
	supportedDataTypes = ['application/x-www-form-urlencoded'];

	async run(requestData) {
		if (requestData.method != 'POST') {
			return super.run(requestData);
		}
		this.checkEditable(requestData);
		let { pathParams, libraryID, data } = requestData;
		let item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, pathParams.itemKey);
		if (!item) {
			return this.makeResponse(404, 'text/plain', 'Not found');
		}
		if (!item.isImportedAttachment()) {
			return this.makeResponse(400, 'text/plain', `Not an imported-file attachment: ${item.key}`);
		}
		if (!data || typeof data != 'object') {
			return this.makeResponse(400, 'text/plain', 'Form body required');
		}
		if (data.upload) {
			return this._register(requestData, item, data);
		}
		return this._authorize(requestData, item, data);
	}

	async _checkFilePrecondition(requestData, item) {
		// Preconditions compare against the REGISTERED file (like the web API, where the
		// server tracks registered metadata, not whatever bytes reached storage) -- phase 2
		// writes bytes to disk before phase 3 registers them
		let existingHash = item.attachmentSyncedHash || null;
		let ifMatch = requestData.headers.get('If-Match');
		let ifNoneMatch = requestData.headers.get('If-None-Match');
		if (ifNoneMatch === '*') {
			if (existingHash) {
				throw new LocalAPIWritesError(412, 'If-None-Match: * set but file exists');
			}
		}
		else if (ifMatch) {
			if (!existingHash) {
				throw new LocalAPIWritesError(412, 'If-Match set but no file exists');
			}
			if (existingHash !== ifMatch) {
				throw new LocalAPIWritesError(412, `If-Match value does not match stored file hash (${existingHash})`);
			}
		}
		else {
			throw new LocalAPIWritesError(428, 'If-Match or If-None-Match: * must be provided');
		}
		return existingHash;
	}

	async _authorize(requestData, item, data) {
		for (let required of ['md5', 'filename', 'filesize', 'mtime']) {
			if (!data[required]) {
				return this.makeResponse(400, 'text/plain', `'${required}' form field not provided`);
			}
		}
		let existingHash = await this._checkFilePrecondition(requestData, item);
		if (existingHash === data.md5) {
			return this.makeResponse(200, 'application/json', JSON.stringify({ exists: 1 }));
		}

		let uploads = Zotero.Server.LocalAPI.Writes._pendingUploads;
		let now = Date.now();
		for (let [key, record] of uploads) {
			if (now - record.created > UPLOAD_KEY_TTL) {
				uploads.delete(key);
			}
		}
		let uploadKey = Zotero.Utilities.randomString(16);
		uploads.set(uploadKey, {
			itemID: item.id,
			md5: data.md5,
			filename: data.filename,
			filesize: parseInt(data.filesize),
			mtime: parseInt(data.mtime),
			created: now,
		});

		// Rebuild the library prefix (users/0 or groups/N) from the request path
		let prefix = requestData.pathname.replace(/\/items\/.+$/, '');
		let url = `http://localhost:${Zotero.Server.port}${prefix}/items/${item.key}/file/upload/${uploadKey}`;
		return this.makeResponse(200, 'application/json', JSON.stringify({
			url,
			contentType: item.attachmentContentType || 'application/octet-stream',
			prefix: '',
			suffix: '',
			uploadKey,
		}));
	}

	async _register(requestData, item, data) {
		await this._checkFilePrecondition(requestData, item);
		let record = Zotero.Server.LocalAPI.Writes._pendingUploads.get(data.upload);
		if (!record || record.itemID !== item.id) {
			return this.makeResponse(400, 'text/plain', 'Unknown upload key');
		}
		let path = await item.getFilePathAsync();
		if (!path) {
			return this.makeResponse(400, 'text/plain', 'No uploaded file found for this upload key');
		}
		let uploadedHash = await Zotero.Utilities.Internal.md5Async(path);
		if (uploadedHash !== record.md5) {
			return this.makeResponse(400, 'text/plain', `Uploaded file hash ${uploadedHash} does not match authorized md5 ${record.md5}`);
		}
		item.attachmentSyncedModificationTime = record.mtime;
		item.attachmentSyncedHash = record.md5;
		item.attachmentSyncState = Zotero.Sync.Storage.Local.SYNC_STATE_TO_UPLOAD;
		await item.saveTx({ skipAll: true });
		Zotero.Server.LocalAPI.Writes._pendingUploads.delete(data.upload);
		return this.makeResponse(204, 'text/plain', '');
	}
});
Zotero.Server.Endpoints["/api/users/:userID/items/:itemKey/file"] = Zotero.Server.LocalAPI.ItemFileWrite;
Zotero.Server.Endpoints["/api/groups/:groupID/items/:itemKey/file"] = Zotero.Server.LocalAPI.ItemFileWrite;


/**
 * File-upload dance, phase 2: raw file bytes (local-only extension; the web API sends
 * clients to S3/WebDAV instead). The body is streamed to the attachment's storage
 * directory under the authorized filename.
 */
Zotero.Server.LocalAPI.ItemFileUpload = writeEndpoint(class extends Zotero.Server.LocalAPI.Endpoint {
	supportedMethods = ['POST'];
	supportedDataTypes = '*';

	async run(requestData) {
		let { pathParams, libraryID } = requestData;
		let record = Zotero.Server.LocalAPI.Writes._pendingUploads.get(pathParams.uploadKey);
		if (!record || Date.now() - record.created > UPLOAD_KEY_TTL) {
			return this.makeResponse(410, 'text/plain', 'Upload key unknown or expired -- re-authorize');
		}
		let item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, pathParams.itemKey);
		if (!item || item.id !== record.itemID) {
			return this.makeResponse(404, 'text/plain', 'Not found');
		}
		this.checkEditable(requestData);

		let bytes;
		let data = requestData.data;
		if (data instanceof Ci.nsIInputStream) {
			let length = parseInt(requestData.headers.get('Content-Length')) || data.available();
			let byteString = NetUtil.readInputStreamToString(data, length);
			bytes = Uint8Array.from(byteString, c => c.charCodeAt(0));
		}
		else if (typeof data == 'string') {
			bytes = Uint8Array.from(data, c => c.charCodeAt(0));
		}
		else {
			return this.makeResponse(400, 'text/plain', 'Raw request body required');
		}
		if (record.filesize && bytes.length !== record.filesize) {
			return this.makeResponse(400, 'text/plain', `Body length ${bytes.length} does not match authorized filesize ${record.filesize}`);
		}

		await Zotero.Attachments.createDirectoryForItem(item);
		let dir = Zotero.Attachments.getStorageDirectory(item).path;
		let filename = Zotero.File.getValidFileName(record.filename.split(/[/\\]/).pop());
		await IOUtils.write(PathUtils.join(dir, filename), bytes);
		if (!item.attachmentPath) {
			item.attachmentPath = 'storage:' + filename;
			await item.saveTx({ skipAll: true });
		}
		return this.makeResponse(201, 'text/plain', '');
	}
});
Zotero.Server.Endpoints["/api/users/:userID/items/:itemKey/file/upload/:uploadKey"] = Zotero.Server.LocalAPI.ItemFileUpload;
Zotero.Server.Endpoints["/api/groups/:groupID/items/:itemKey/file/upload/:uploadKey"] = Zotero.Server.LocalAPI.ItemFileUpload;

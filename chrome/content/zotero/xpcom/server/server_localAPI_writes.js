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

Fork-only Local API extensions that stock Zotero does not provide (contract ADR-0014/ADR-0015):

- GET/POST/DELETE <lib>/settings   read/write synced settings
- POST <lib>/capture               thin capture: translate captured HTML server-side,
                                   webpage-item fallback

Item, collection, search, tag, fulltext and file writes are owned by stock server_localAPI.js.
These endpoints subclass the exported stock endpoint classes, so they inherit stock server-ID
validation, write authentication, editability checks and HTTPError handling.

Version semantics: Zotero.Library#clientVersion is the local monotonic counter. Settings
mutations increment it once per transaction; the sync-owned libraryVersion is never modified.

*/

const CAPTURE_IDEMPOTENCY_LIMIT = 100;

const { Endpoint: WritesBaseEndpoint, HTTPError: WritesHTTPError } = Zotero.Server.LocalAPI;

Zotero.Server.LocalAPI.Writes = {
	// clientKey -> { libraryID, itemKey, response: [status, headers, body] } of the original capture response
	_captureResults: new Map(),
};

function apiURL() {
	return `http://localhost:${Zotero.Server.port}/api/`;
}

function toWriteEnvelope(dataObject) {
	return dataObject.toResponseJSONAsync
		? dataObject.toResponseJSONAsync({ apiURL: apiURL(), includeGroupDetails: true })
		: dataObject;
}

async function makeWriteResultResponse(endpoint, requestData, status, saved, failed, unchanged = {}) {
	let result = {
		successful: {},
		success: {},
		unchanged,
		failed,
	};
	for (let [index, object] of saved) {
		result.successful[String(index)] = await toWriteEnvelope(object);
		result.success[String(index)] = object.key;
	}
	return endpoint.makeResponse(
		status,
		{
			'Content-Type': 'application/json',
			'Last-Modified-Version': Zotero.Libraries.get(requestData.libraryID).clientVersion,
		},
		JSON.stringify(result, null, 4)
	);
}

Zotero.Server.LocalAPI.SettingsWrite = class extends Zotero.Server.LocalAPI.Settings {
	supportedMethods = ['GET', 'POST', 'DELETE'];
	supportedDataTypes = ['application/json'];

	async run(requestData) {
		let library = Zotero.Libraries.get(requestData.libraryID);
		if (requestData.method == 'GET') {
			let clientVersion = library.clientVersion;
			let header = requestData.headers.get('If-Modified-Since-Version');
			if (header !== null) {
				let version = parseInt(header);
				if (Number.isNaN(version)) {
					return this.makeResponse(400, 'text/plain', `Invalid 'If-Modified-Since-Version' value '${header}'`);
				}
				if (version >= clientVersion) {
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
				'Last-Modified-Version': clientVersion,
			}, JSON.stringify(settings, null, 4));
		}

		this._checkLibraryIfUnmodifiedSinceVersion(requestData);
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
			await Zotero.DB.executeTransaction(async () => {
				let changed = false;
				for (let [key, wrapper] of entries) {
					try {
						if (!wrapper || typeof wrapper != 'object' || Array.isArray(wrapper)
							|| !Object.prototype.hasOwnProperty.call(wrapper, 'value')) {
							throw new WritesHTTPError(400, "Setting must contain a 'value' property");
						}
						if (await Zotero.SyncedSettings.set(requestData.libraryID, key, wrapper.value)) {
							changed = true;
						}
					}
					catch (e) {
						if (!(e instanceof WritesHTTPError)) Zotero.logError(e);
						failed[key] = {
							code: e instanceof WritesHTTPError ? e.status : 400,
							message: e.message,
						};
					}
				}
				if (changed) {
					await library.incrementClientVersion();
				}
			});
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
		await Zotero.DB.executeTransaction(async () => {
			let changed = false;
			for (let key of keys) {
				if (await Zotero.SyncedSettings.clear(requestData.libraryID, key)) {
					changed = true;
				}
			}
			if (changed) {
				await library.incrementClientVersion();
			}
		});
		return this.makeResponse(204, 'text/plain', '');
	}
};
Zotero.Server.Endpoints["/api/users/:userID/settings"] = Zotero.Server.LocalAPI.SettingsWrite;
Zotero.Server.Endpoints["/api/groups/:groupID/settings"] = Zotero.Server.LocalAPI.SettingsWrite;


/**
/**
 * Thin capture (contract ADR-0014/ADR-0015): the client sends the URL and page HTML the
 * user actually saw; translation runs here, replaying the captured HTML through the
 * translator framework (same recipe as the connector's Detect/SaveItems path). When no
 * translator matches -- or `translate` is false, or no HTML was captured -- an untranslated
 * `webpage` item is saved instead, so the save never fails for lack of a translator.
 */
Zotero.Server.LocalAPI.Capture = class extends WritesBaseEndpoint {
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

		// Idempotent replay: a clientKey we have already processed returns the original
		// result with a 200 instead of creating a duplicate -- but only while the created
		// item still exists; once it has been deleted, the same clientKey creates fresh
		let seen = Zotero.Server.LocalAPI.Writes._captureResults;
		if (clientKey && seen.has(clientKey)) {
			let cached = seen.get(clientKey);
			if (Zotero.Items.getByLibraryAndKey(cached.libraryID, cached.itemKey)) {
				let [, headers, body] = cached.response;
				return this.makeResponse(200, {
					...headers,
					'Last-Modified-Version': Zotero.Libraries.get(requestData.libraryID).clientVersion,
				}, body);
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

		let response = await makeWriteResultResponse(
			this,
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
};
Zotero.Server.Endpoints["/api/users/:userID/capture"] = Zotero.Server.LocalAPI.Capture;
Zotero.Server.Endpoints["/api/groups/:groupID/capture"] = Zotero.Server.LocalAPI.Capture;

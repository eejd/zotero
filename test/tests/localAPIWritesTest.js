"use strict";

describe("Local API fork extensions (settings, capture)", function () {
	let apiRoot;
	let userLibraryID;
	let serverID;
	let writeAPIKey;

	function apiRequest(method, endpoint, options = {}) {
		let { headers, skipAPIKey, skipServerID, ...rest } = options;
		let requestHeaders = {
			"Zotero-Allowed-Request": "1",
			...(headers || {})
		};
		if (method != "GET" && !skipAPIKey && writeAPIKey && !requestHeaders["Zotero-API-Key"]) {
			requestHeaders["Zotero-API-Key"] = writeAPIKey;
		}
		if (method != "GET" && !skipServerID && serverID && !requestHeaders["Zotero-Server-ID"]) {
			requestHeaders["Zotero-Server-ID"] = serverID;
		}
		return Zotero.HTTP.request(method, apiRoot + endpoint, {
			...rest,
			headers: requestHeaders
		});
	}

	function apiPostJSON(endpoint, body, options = {}) {
		return apiRequest("POST", endpoint, {
			...options,
			headers: { "Content-Type": "application/json", ...(options.headers || {}) },
			body: JSON.stringify(body),
			responseType: "json"
		});
	}

	// Obtain a remembered API key through the stock authorization endpoint
	async function setupRememberedAPIKey(appName = "Fork Extension Tests") {
		let stub = sinon.stub(Zotero.Server.LocalAPI, "_promptForAuthorization")
			.resolves({ allow: true, remember: true });
		try {
			let { response } = await Zotero.HTTP.request("POST", apiRoot + "/local/authorize", {
				headers: {
					"Zotero-Allowed-Request": "1",
					"Content-Type": "application/json",
					"Zotero-Server-ID": serverID,
				},
				body: JSON.stringify({ appName }),
				responseType: "json"
			});
			return response.key;
		}
		finally {
			stub.restore();
		}
	}

	before(async function () {
		// The test profile binds the server on a dedicated port with localAPI enabled;
		// read the port only after resetDB(), which reloads the server module
		await resetDB({
			thisArg: this
		});
		apiRoot = "http://127.0.0.1:" + Zotero.Server.port + "/api";
		userLibraryID = Zotero.Libraries.userLibraryID;
		serverID = Zotero.Server.LocalAPI.getServerID();
		writeAPIKey = await setupRememberedAPIKey();
	});

	describe("write authentication (inherited from stock)", function () {
		it("should return 428 for a write without a Zotero-Server-ID", async function () {
			let e = await getPromiseError(apiPostJSON("/users/0/settings", { s: { value: 1 } }, { skipServerID: true }));
			assert.equal(e.status, 428);
		});

		it("should return 401 for a write with the server ID but no API key", async function () {
			let e = await getPromiseError(apiPostJSON("/users/0/capture", { url: "https://example.org/x" }, { skipAPIKey: true }));
			assert.equal(e.status, 401);
		});

		it("should not apply a settings write rejected for authentication", async function () {
			await getPromiseError(apiPostJSON("/users/0/settings", { unauthSetting: { value: 1 } }, { skipAPIKey: true }));
			assert.isNull(Zotero.SyncedSettings.get(userLibraryID, "unauthSetting"));
		});
	});

	describe("GET + POST + DELETE /api/users/:userID/settings", function () {
		it("should round-trip setting wrappers", async function () {
			let response = await apiPostJSON('/users/0/settings', {
				localAPITest: { value: { enabled: true } }
			});
			assert.equal(response.status, 204);
			assert.deepEqual(Zotero.SyncedSettings.get(userLibraryID, 'localAPITest'), { enabled: true });

			response = await apiRequest('GET', '/users/0/settings', { responseType: 'json' });
			assert.deepEqual(response.response.localAPITest.value, { enabled: true });
			assert.property(response.response.localAPITest, 'version');

			response = await apiRequest('DELETE', '/users/0/settings?settingKey=localAPITest', {
				successCodes: [204]
			});
			assert.equal(response.status, 204);
			assert.isNull(Zotero.SyncedSettings.get(userLibraryID, 'localAPITest'));
		});

		it("should return 304 for a current If-Modified-Since-Version", async function () {
			let version = Zotero.Libraries.get(userLibraryID).clientVersion;
			let response = await apiRequest('GET', '/users/0/settings', {
				headers: { 'If-Modified-Since-Version': String(version) },
				successCodes: [304]
			});
			assert.equal(response.status, 304);
		});

		it("should report malformed settings without rejecting valid siblings", async function () {
			let response = await apiPostJSON('/users/0/settings', {
				validSetting: { value: 1 },
				invalidSetting: { missing: 'value' }
			});
			assert.equal(response.status, 200);
			assert.equal(Zotero.SyncedSettings.get(userLibraryID, 'validSetting'), 1);
			assert.equal(response.response.failed.invalidSetting.code, 400);
			await Zotero.SyncedSettings.clear(userLibraryID, 'validSetting');
		});

		it("should expose the same write surface for group libraries", async function () {
			let group = await createGroup();
			let response = await apiPostJSON(`/groups/${group.groupID}/settings`, {
				groupSetting: { value: 'shared' }
			});
			assert.equal(response.status, 204);
			assert.equal(Zotero.SyncedSettings.get(group.libraryID, 'groupSetting'), 'shared');
			await apiRequest('DELETE', `/groups/${group.groupID}/settings?settingKey=groupSetting`, {
				successCodes: [204]
			});
		});

		it("should change the client counter so a stale If-Modified-Since-Version GET returns 200", async function () {
			let before = Zotero.Libraries.get(userLibraryID).clientVersion;
			await apiPostJSON("/users/0/settings", { counterSetting: { value: "a" } });
			let after = Zotero.Libraries.get(userLibraryID).clientVersion;
			assert.isAbove(after, before);
			let response = await apiRequest("GET", "/users/0/settings", {
				headers: { "If-Modified-Since-Version": String(before) },
				responseType: "json"
			});
			assert.equal(response.status, 200);
			assert.equal(response.getResponseHeader("Last-Modified-Version"), String(after));
			await apiRequest("DELETE", "/users/0/settings?settingKey=counterSetting", { successCodes: [204] });
		});

		it("should not change the counter when no setting changes", async function () {
			await apiPostJSON("/users/0/settings", { counterNoop: { value: "a" } });
			let before = Zotero.Libraries.get(userLibraryID).clientVersion;
			await apiRequest("DELETE", "/users/0/settings?settingKey=doesNotExist", { successCodes: [204] });
			assert.equal(Zotero.Libraries.get(userLibraryID).clientVersion, before);
			await apiRequest("DELETE", "/users/0/settings?settingKey=counterNoop", { successCodes: [204] });
		});

		it("should not bump the sync-owned libraryVersion", async function () {
			let before = Zotero.Libraries.get(userLibraryID).libraryVersion;
			await apiPostJSON("/users/0/settings", { syncVersionSetting: { value: 1 } });
			assert.equal(Zotero.Libraries.get(userLibraryID).libraryVersion, before);
			await apiRequest("DELETE", "/users/0/settings?settingKey=syncVersionSetting", { successCodes: [204] });
		});
	});

	describe("POST /api/users/:userID/capture", function () {
		it("should save a fallback webpage item when translation is disabled", async function () {
			let collection = await createDataObject('collection', { setTitle: true });
			let response = await apiPostJSON('/users/0/capture', {
				url: 'https://example.org/capture-fallback',
				title: 'Capture Fallback Page',
				html: '<html><head><title>Capture Fallback Page</title></head><body><p>x</p></body></html>',
				translate: false,
				saveSnapshot: false,
				collections: [collection.key],
				tags: [{ tag: 'captured' }]
			});
			assert.equal(response.status, 201);
			let envelope = response.response.successful['0'];
			assert.equal(envelope.data.itemType, 'webpage');
			assert.equal(envelope.data.title, 'Capture Fallback Page');
			assert.equal(envelope.data.url, 'https://example.org/capture-fallback');
			let item = Zotero.Items.getByLibraryAndKey(userLibraryID, envelope.key);
			assert.include(item.getCollections(), collection.id);
			assert.ok(item.getTags().find(t => t.tag == 'captured'));
		});

		it("should store the captured HTML as a snapshot attachment", async function () {
			let response = await apiPostJSON('/users/0/capture', {
				url: 'https://example.org/capture-snapshot',
				title: 'Capture Snapshot Page',
				html: '<html><head><title>Capture Snapshot Page</title></head><body><p>content</p></body></html>',
				translate: false,
				saveSnapshot: true
			});
			assert.equal(response.status, 201);
			let item = Zotero.Items.getByLibraryAndKey(userLibraryID, response.response.successful['0'].key);
			let childIDs = item.getAttachments();
			assert.lengthOf(childIDs, 1);
			let attachment = Zotero.Items.get(childIDs[0]);
			assert.isTrue(attachment.isImportedAttachment());
			assert.equal(attachment.attachmentContentType, 'text/html');
		});

		it("should replay idempotently for a repeated clientKey", async function () {
			let payload = {
				url: 'https://example.org/capture-idempotent',
				title: 'Capture Idempotent Page',
				translate: false,
				saveSnapshot: false,
				clientKey: 'test-client-key-1'
			};
			let first = await apiPostJSON('/users/0/capture', payload);
			assert.equal(first.status, 201);
			let second = await apiPostJSON('/users/0/capture', payload);
			assert.equal(second.status, 200);
			assert.equal(second.response.success['0'], first.response.success['0']);
			let matches = await apiRequest('GET', '/users/0/items?q=Capture Idempotent Page', { responseType: 'json' });
			assert.lengthOf(matches.response, 1);
		});

		it("should create fresh when the cached clientKey item was deleted", async function () {
			let payload = {
				url: 'https://example.org/capture-evicted',
				title: 'Capture Evicted Page',
				translate: false,
				saveSnapshot: false,
				clientKey: 'test-client-key-2'
			};
			let first = await apiPostJSON('/users/0/capture', payload);
			assert.equal(first.status, 201);
			let key = first.response.success['0'];
			let item = Zotero.Items.getByLibraryAndKey(userLibraryID, key);
			await item.eraseTx();
			// The replay must not resurrect a response for an item that no longer exists
			let second = await apiPostJSON('/users/0/capture', payload);
			assert.equal(second.status, 201);
			assert.notEqual(second.response.success['0'], key);
			assert.ok(Zotero.Items.getByLibraryAndKey(userLibraryID, second.response.success['0']));
		});

		it("should translate captured HTML with embedded metadata", async function () {
			let translators = await Zotero.Translators.getAllForType('web');
			if (!translators.find(t => t.label == 'Embedded Metadata')) {
				this.skip();
				return;
			}
			let response = await apiPostJSON('/users/0/capture', {
				url: 'https://example.org/capture-translated',
				html: '<html><head>'
					+ '<meta name="citation_title" content="Translated Capture Article">'
					+ '<meta name="citation_author" content="Doe, Jane">'
					+ '<meta name="citation_journal_title" content="Journal of Tests">'
					+ '<title>Translated Capture Article</title>'
					+ '</head><body><p>abstract</p></body></html>',
				translate: true,
				saveSnapshot: false
			});
			assert.equal(response.status, 201);
			let data = response.response.successful['0'].data;
			assert.equal(data.itemType, 'journalArticle');
			assert.equal(data.title, 'Translated Capture Article');
			assert.equal(data.publicationTitle, 'Journal of Tests');
			assert.lengthOf(data.creators, 1);
		});

		it("should return 400 without a url", async function () {
			try {
				await apiPostJSON('/users/0/capture', { title: 'No URL' });
				assert.fail('Expected 400');
			}
			catch (e) {
				assert.equal(e.status, 400);
			}
		});
	});
});

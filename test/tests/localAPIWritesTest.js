"use strict";

describe("Local API Writes", function () {
	let apiRoot;
	let userLibraryID;

	function apiRequest(method, endpoint, options = {}) {
		return Zotero.HTTP.request(method, apiRoot + endpoint, {
			...options,
			headers: {
				'Zotero-Allowed-Request': '1',
				...(options.headers || {})
			}
		});
	}

	function apiPostJSON(endpoint, body, headers = {}) {
		return apiRequest('POST', endpoint, {
			headers: { 'Content-Type': 'application/json', ...headers },
			body: JSON.stringify(body),
			responseType: 'json'
		});
	}

	before(async function () {
		// The test profile binds the server on a dedicated port with localAPI enabled;
		// read the port only after resetDB(), which reloads the server module
		await resetDB({
			thisArg: this
		});
		apiRoot = 'http://127.0.0.1:' + Zotero.Server.port + '/api';
		userLibraryID = Zotero.Libraries.userLibraryID;
	});

	describe("POST /api/users/:userID/items", function () {
		it("should create items in one batch and return a WriteResult", async function () {
			let response = await apiPostJSON('/users/0/items', [
				{
					itemType: 'journalArticle',
					title: 'Batch Item One',
					creators: [{ creatorType: 'author', firstName: 'A', lastName: 'B' }],
					tags: [{ tag: 'batch' }]
				},
				{
					itemType: 'book',
					title: 'Batch Item Two'
				}
			]);
			assert.equal(response.status, 200);
			let result = response.response;
			assert.lengthOf(Object.keys(result.successful), 2);
			assert.deepEqual(result.failed, {});
			assert.equal(result.successful['0'].data.title, 'Batch Item One');
			assert.equal(result.successful['0'].data.tags[0].tag, 'batch');
			let item = Zotero.Items.getByLibraryAndKey(userLibraryID, result.success['0']);
			assert.ok(item);
			assert.equal(item.getField('title'), 'Batch Item One');
		});

		it("should honor a client-supplied key for a new item", async function () {
			let key = Zotero.DataObjectUtilities.generateKey();
			let response = await apiPostJSON('/users/0/items', [
				{ itemType: 'book', key, title: 'Client Key Item' }
			]);
			assert.equal(response.status, 200);
			assert.equal(response.response.success['0'], key);
			assert.ok(Zotero.Items.getByLibraryAndKey(userLibraryID, key));
		});

		it("should fail an individual object on a version mismatch", async function () {
			let item = await createDataObject('item', { setTitle: true });
			item.version = 5;
			await item.saveTx({ skipAll: true });
			let response = await apiPostJSON('/users/0/items', [
				{ itemType: 'book', key: item.key, version: 1, title: 'Stale Update' }
			]);
			assert.equal(response.status, 200);
			let failure = response.response.failed['0'];
			assert.equal(failure.code, 412);
			assert.notEqual(item.getField('title'), 'Stale Update');
		});

		it("should return 412 when If-Unmodified-Since-Version is stale", async function () {
			let library = Zotero.Libraries.get(userLibraryID);
			let previousVersion = library.libraryVersion;
			library.libraryVersion = 10;
			await library.saveTx();
			try {
				let response = await apiPostJSON('/users/0/items',
					[{ itemType: 'book', title: 'Rejected' }],
					{ 'If-Unmodified-Since-Version': '5' });
				assert.fail('Expected 412, got ' + response.status);
			}
			catch (e) {
				assert.equal(e.status, 412);
			}
			finally {
				// The setter forbids decreases except to the -1 "full sync needed" sentinel,
				// so restore by resetting first
				library.libraryVersion = -1;
				if (previousVersion >= 0) {
					library.libraryVersion = previousVersion;
				}
				await library.saveTx();
			}
		});

		it("should return 413 for more than 100 objects", async function () {
			let body = Array.from({ length: 101 }, (_, i) => ({ itemType: 'book', title: `Overflow ${i}` }));
			try {
				let response = await apiPostJSON('/users/0/items', body);
				assert.fail('Expected 413, got ' + response.status);
			}
			catch (e) {
				assert.equal(e.status, 413);
			}
		});
	});

	describe("PATCH /api/users/:userID/items/:itemKey", function () {
		it("should merge-patch, preserving unlisted fields", async function () {
			let item = await createDataObject('item', { itemType: 'journalArticle' });
			item.setField('title', 'Patch Target');
			item.setField('abstractNote', 'before');
			await item.saveTx();
			let response = await apiRequest('PATCH', `/users/0/items/${item.key}`, {
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ abstractNote: 'after' }),
				successCodes: [204]
			});
			assert.equal(response.status, 204);
			assert.equal(item.getField('abstractNote'), 'after');
			assert.equal(item.getField('title'), 'Patch Target');
		});

		it("should return 412 on a body version mismatch", async function () {
			let item = await createDataObject('item', { setTitle: true });
			item.version = 7;
			await item.saveTx({ skipAll: true });
			try {
				await apiRequest('PATCH', `/users/0/items/${item.key}`, {
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ version: 2, abstractNote: 'stale' })
				});
				assert.fail('Expected 412');
			}
			catch (e) {
				assert.equal(e.status, 412);
			}
		});

		it("should return 404 for a missing item", async function () {
			try {
				await apiRequest('PATCH', '/users/0/items/AAAAAAAA', {
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ abstractNote: 'x' })
				});
				assert.fail('Expected 404');
			}
			catch (e) {
				assert.equal(e.status, 404);
			}
		});
	});

	describe("DELETE /api/users/:userID/items", function () {
		it("should delete existing items and ignore unknown keys", async function () {
			let item1 = await createDataObject('item', { setTitle: true });
			let item2 = await createDataObject('item', { setTitle: true });
			let response = await apiRequest('DELETE',
				`/users/0/items?itemKey=${item1.key},${item2.key},AAAAAAAA`,
				{ successCodes: [204] });
			assert.equal(response.status, 204);
			assert.isFalse(Zotero.Items.getByLibraryAndKey(userLibraryID, item1.key));
			assert.isFalse(Zotero.Items.getByLibraryAndKey(userLibraryID, item2.key));
		});
	});

	describe("POST + DELETE /api/users/:userID/collections", function () {
		it("should round-trip a collection", async function () {
			let response = await apiPostJSON('/users/0/collections', [
				{ name: 'Write Test Collection' }
			]);
			assert.equal(response.status, 200);
			let key = response.response.success['0'];
			assert.ok(Zotero.Collections.getByLibraryAndKey(userLibraryID, key));
			await apiRequest('DELETE', `/users/0/collections?collectionKey=${key}`, { successCodes: [204] });
			assert.isFalse(Zotero.Collections.getByLibraryAndKey(userLibraryID, key));
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

	describe("file upload dance", function () {
		it("should authorize, accept bytes, register, and serve the file", async function () {
			let bytes = 'fake pdf bytes for upload test';
			let md5 = Zotero.Utilities.Internal.md5(bytes);

			// 1. Create a standalone imported-file attachment item
			let createResponse = await apiPostJSON('/users/0/items', [{
				itemType: 'attachment',
				linkMode: 'imported_file',
				title: 'Upload Dance Target',
				filename: 'upload-test.txt',
				contentType: 'text/plain'
			}]);
			assert.equal(createResponse.status, 200);
			let itemKey = createResponse.response.success['0'];

			// 2. Authorize
			let authResponse = await apiRequest('POST', `/users/0/items/${itemKey}/file`, {
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'If-None-Match': '*'
				},
				body: `md5=${md5}&filename=upload-test.txt&filesize=${bytes.length}&mtime=1700000000000`,
				responseType: 'json'
			});
			assert.equal(authResponse.status, 200);
			let auth = authResponse.response;
			assert.ok(auth.uploadKey);
			assert.include(auth.url, `/items/${itemKey}/file/upload/${auth.uploadKey}`);

			// 3. Upload the bytes
			let uploadResponse = await Zotero.HTTP.request('POST', auth.url, {
				headers: {
					'Zotero-Allowed-Request': '1',
					'Content-Type': 'application/octet-stream'
				},
				body: bytes,
				successCodes: [201]
			});
			assert.equal(uploadResponse.status, 201);

			// 4. Register
			let registerResponse = await apiRequest('POST', `/users/0/items/${itemKey}/file`, {
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'If-None-Match': '*'
				},
				body: `upload=${auth.uploadKey}`,
				successCodes: [204]
			});
			assert.equal(registerResponse.status, 204);

			let item = Zotero.Items.getByLibraryAndKey(userLibraryID, itemKey);
			assert.isTrue(await item.fileExists());
			assert.equal(await item.attachmentHash, md5);
			assert.equal(item.attachmentSyncedHash, md5);

			// 5. Same md5 authorizes to {exists: 1}; a new file precondition now fails
			let existsResponse = await apiRequest('POST', `/users/0/items/${itemKey}/file`, {
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'If-Match': md5
				},
				body: `md5=${md5}&filename=upload-test.txt&filesize=${bytes.length}&mtime=1700000000000`,
				responseType: 'json'
			});
			assert.equal(existsResponse.response.exists, 1);

			try {
				await apiRequest('POST', `/users/0/items/${itemKey}/file`, {
					headers: {
						'Content-Type': 'application/x-www-form-urlencoded',
						'If-None-Match': '*'
					},
					body: `md5=${md5}&filename=upload-test.txt&filesize=${bytes.length}&mtime=1700000000000`
				});
				assert.fail('Expected 412');
			}
			catch (e) {
				assert.equal(e.status, 412);
			}
		});

		it("should return 410 for an unknown upload key", async function () {
			let item = await importFileAttachment('test.png');
			try {
				await apiRequest('POST', `/users/0/items/${item.key}/file/upload/UNKNOWNKEY123456`, {
					headers: { 'Content-Type': 'application/octet-stream' },
					body: 'x'
				});
				assert.fail('Expected 410');
			}
			catch (e) {
				assert.equal(e.status, 410);
			}
		});
	});
});

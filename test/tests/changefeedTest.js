"use strict";

describe("Local API changefeed", function () {
	let apiRoot;
	let feed;

	before(async function () {
		apiRoot = `http://127.0.0.1:${Zotero.Server.port}/api`;
		await resetDB({ thisArg: this });
		feed = Zotero.Server.LocalAPI.Changefeed;
	});

	beforeEach(function () {
		feed._resetForTests();
	});

	afterEach(function () {
		for (let stream of [...Zotero.Server._activeStreams]) stream.close();
		feed.heartbeatInterval = 15000;
	});

	async function waitFor(predicate, message) {
		for (let i = 0; i < 100; i++) {
			if (predicate()) return;
			await Zotero.Promise.delay(10);
		}
		assert.fail(message);
	}

	async function openFeed(path, headers = {}) {
		let xhr;
		let request = Zotero.HTTP.request('GET', apiRoot + path, {
			headers: {
				Accept: 'text/event-stream',
				'Zotero-Allowed-Request': '1',
				...headers,
			},
			responseType: 'text',
			requestObserver: requestXHR => xhr = requestXHR,
		});
		await waitFor(() => feed._subscribers.size > 0, 'changefeed subscriber did not connect');
		return { request, xhr };
	}

	async function finishFeed(connection) {
		for (let stream of [...Zotero.Server._activeStreams]) stream.close();
		return connection.request;
	}

	function changes(responseText) {
		return responseText.split('\n')
			.filter(line => line.startsWith('data: '))
			.map(line => JSON.parse(line.substring(6)));
	}

	it("should emit notifier changes with the actual library version as the SSE id", async function () {
		let library = Zotero.Libraries.userLibrary;
		library.libraryVersion = 17;
		await library.saveTx();

		let connection = await openFeed('/users/0/changefeed');
		let item = await createDataObject('item', { setTitle: true });
		let response = await finishFeed(connection);

		assert.equal(response.getResponseHeader('Content-Type'), 'text/event-stream');
		let events = changes(response.responseText);
		assert.lengthOf(events, 1);
		assert.deepEqual(events[0], {
			event: 'add',
			type: 'item',
			keys: [item.key],
			version: library.libraryVersion,
			libraryID: library.libraryID,
		});
		assert.include(response.responseText, `id: ${library.libraryVersion}\n`);
	});

	it("should support the group route and filter by group library", async function () {
		let group = await createGroup();
		feed._resetForTests();
		let connection = await openFeed(`/groups/${group.id}/changefeed`);
		let item = await createDataObject('item', { libraryID: group.libraryID, setTitle: true });
		await createDataObject('item', { setTitle: true });
		let response = await finishFeed(connection);

		let events = changes(response.responseText);
		assert.lengthOf(events, 1);
		assert.deepEqual(events[0].keys, [item.key]);
		assert.equal(events[0].libraryID, group.libraryID);
	});

	it("should replay the resume version so same-version local edits are not missed", async function () {
		let library = Zotero.Libraries.userLibrary;
		let version = library.libraryVersion;
		let first = await openFeed('/users/0/changefeed');
		let firstItem = await createDataObject('item', { setTitle: true });
		await finishFeed(first);

		// This edit occurs with no HTTP subscriber and does not advance libraryVersion.
		let missedItem = await createDataObject('item', { setTitle: true });
		assert.equal(library.libraryVersion, version);

		let resumed = await openFeed('/users/0/changefeed', { 'Last-Event-ID': String(version) });
		let response = await finishFeed(resumed);
		let keys = changes(response.responseText).flatMap(event => event.keys);
		assert.include(keys, firstItem.key); // at-least-once replay may duplicate the resume version
		assert.include(keys, missedItem.key);
	});

	it("should prefer ?since over Last-Event-ID and reject invalid versions", async function () {
		try {
			await Zotero.HTTP.request('GET', apiRoot + '/users/0/changefeed?since=invalid', {
				headers: {
					'Last-Event-ID': '1',
					'Zotero-Allowed-Request': '1',
				},
			});
			assert.fail('Expected a 400 response');
		}
		catch (e) {
			assert.equal(e.status, 400);
		}
	});

	it("should send heartbeats and tear down the subscriber after a client disconnect", async function () {
		feed.heartbeatInterval = 10;
		let connection = await openFeed('/users/0/changefeed');
		await waitFor(
			() => connection.xhr.responseText.includes(': heartbeat\n\n'),
			'changefeed heartbeat was not sent'
		);
		connection.xhr.abort();
		await waitFor(() => feed._subscribers.size === 0, 'disconnected subscriber was not removed');
	});
});

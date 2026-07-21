"use strict";

describe("Local API Change Feed", function () {
	let apiRoot;

	function openChangeFeed(endpoint, headers = {}) {
		let xhr = new XMLHttpRequest();
		let offset = 0;
		let buffer = '';
		let frames = [];
		let waiters = [];

		function deliver(frame) {
			let waiter = waiters.shift();
			if (waiter) {
				clearTimeout(waiter.timer);
				waiter.resolve(frame);
			}
			else {
				frames.push(frame);
			}
		}

		function parseFrame(raw) {
			let frame = { raw };
			let data = [];
			for (let line of raw.split('\n')) {
				if (line.startsWith(':')) frame.comment = line.slice(1).trim();
				else if (line.startsWith('id:')) frame.id = parseInt(line.slice(3).trim());
				else if (line.startsWith('event:')) frame.event = line.slice(6).trim();
				else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
			}
			if (data.length) frame.data = JSON.parse(data.join('\n'));
			return frame;
		}

		xhr.open('GET', apiRoot + endpoint);
		xhr.setRequestHeader('Zotero-Allowed-Request', '1');
		xhr.setRequestHeader('Accept', 'text/event-stream');
		for (let [name, value] of Object.entries(headers)) {
			xhr.setRequestHeader(name, value);
		}
		xhr.onprogress = () => {
			buffer += xhr.responseText.slice(offset);
			offset = xhr.responseText.length;
			let boundary;
			while ((boundary = buffer.indexOf('\n\n')) !== -1) {
				let raw = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				deliver(parseFrame(raw));
			}
		};
		xhr.onerror = () => {
			for (let waiter of waiters.splice(0)) {
				clearTimeout(waiter.timer);
				waiter.reject(new Error('Changefeed request failed'));
			}
		};
		xhr.send();

		return {
			xhr,
			nextFrame(timeout = 5000) {
				if (frames.length) return Promise.resolve(frames.shift());
				return new Promise((resolve, reject) => {
					let waiter = { resolve, reject };
					waiter.timer = setTimeout(() => {
						let index = waiters.indexOf(waiter);
						if (index !== -1) waiters.splice(index, 1);
						reject(new Error('Timed out waiting for changefeed frame'));
					}, timeout);
					waiters.push(waiter);
				});
			},
			abort() {
				xhr.abort();
			}
		};
	}

	async function waitForEvent(connection) {
		while (true) {
			let frame = await connection.nextFrame();
			if (frame.data) return frame;
		}
	}

	async function waitForKey(connection, key) {
		while (true) {
			let frame = await waitForEvent(connection);
			if (frame.data.keys.includes(key)) return frame;
		}
	}

	before(async function () {
		this.timeout(10000);
		await resetDB({ thisArg: this });
		apiRoot = 'http://127.0.0.1:' + Zotero.Server.port + '/api';
	});

	beforeEach(function () {
		Zotero.Server.LocalAPI.ChangeFeed._reset();
	});

	after(function () {
		Zotero.Server.LocalAPI.ChangeFeed._reset();
	});

	it("should stream notifier changes using the actual library version", async function () {
		let connection = openChangeFeed('/users/0/changefeed?since=0');
		let connected = await connection.nextFrame();
		dump(`CFTEST connected subscribers=${Zotero.Server.LocalAPI.ChangeFeed._subscriberCount()}\n`);
		assert.equal(connected.comment, 'connected');
		assert.equal(connection.xhr.status, 200);
		assert.match(connection.xhr.getResponseHeader('Content-Type'), /^text\/event-stream/);
		assert.equal(connection.xhr.getResponseHeader('Zotero-API-Version'), '3');
		assert.equal(
			connection.xhr.getResponseHeader('Zotero-Schema-Version'),
			String(Zotero.Schema.globalSchemaVersion)
		);

		let item = await createDataObject('item', { setTitle: true });
		dump(`CFTEST item=${item.id}/${item.key} version=${Zotero.Libraries.userLibrary.libraryVersion}\n`);
		let frame = await waitForEvent(connection);
		assert.equal(frame.event, 'change');
		assert.equal(frame.id, frame.data.version);
		assert.equal(frame.data.event, 'add');
		assert.equal(frame.data.type, 'item');
		assert.deepEqual(frame.data.keys, [item.key]);
		assert.equal(frame.data.libraryID, Zotero.Libraries.userLibraryID);
		assert.equal(frame.id, Zotero.Libraries.userLibrary.libraryVersion);
		connection.abort();
	});

	it("should replay changes after reconnecting with since or Last-Event-ID", async function () {
		let firstConnection = openChangeFeed('/users/0/changefeed?since=0');
		await firstConnection.nextFrame();
		let firstItem = await createDataObject('item', { setTitle: true });
		let firstFrame = await waitForEvent(firstConnection);
		assert.deepEqual(firstFrame.data.keys, [firstItem.key]);
		firstConnection.abort();

		let secondItem = await createDataObject('item', { setTitle: true });
		let sinceConnection = openChangeFeed(`/users/0/changefeed?since=${firstFrame.id}`);
		await sinceConnection.nextFrame();
		let secondFrame = await waitForKey(sinceConnection, secondItem.key);
		assert.equal(secondFrame.id, firstFrame.id);
		assert.deepEqual(secondFrame.data.keys, [secondItem.key]);
		sinceConnection.abort();

		let thirdItem = await createDataObject('item', { setTitle: true });
		let headerConnection = openChangeFeed('/users/0/changefeed', {
			'Last-Event-ID': String(secondFrame.id)
		});
		await headerConnection.nextFrame();
		let thirdFrame = await waitForKey(headerConnection, thirdItem.key);
		assert.equal(thirdFrame.id, secondFrame.id);
		assert.deepEqual(thirdFrame.data.keys, [thirdItem.key]);
		headerConnection.abort();
	});

	it("should stream changes from a group library route", async function () {
		let group = await createGroup();
		let connection = openChangeFeed(`/groups/${group.id}/changefeed?since=0`);
		await connection.nextFrame();

		await createDataObject('item', { setTitle: true });
		let item = await createDataObject('item', {
			libraryID: group.libraryID,
			setTitle: true
		});
		let frame = await waitForEvent(connection);
		assert.deepEqual(frame.data.keys, [item.key]);
		assert.equal(frame.data.libraryID, group.libraryID);
		assert.equal(frame.data.type, 'item');
		assert.equal(frame.id, group.libraryVersion);
		connection.abort();
	});

	it("should send heartbeats and release disconnected subscribers", async function () {
		let connection = openChangeFeed('/users/0/changefeed');
		await connection.nextFrame();
		Zotero.Server.LocalAPI.ChangeFeed._heartbeat();
		let heartbeat = await connection.nextFrame();
		assert.equal(heartbeat.comment, 'heartbeat');
		connection.abort();

		// A write probes the seized response stream immediately instead of waiting for the next
		// scheduled heartbeat to discover that the client closed the socket.
		await createDataObject('item', { setTitle: true });
		for (let i = 0; i < 20
				&& Zotero.Server.LocalAPI.ChangeFeed._subscriberCount(); i++) {
			await Zotero.Promise.delay(100);
			Zotero.Server.LocalAPI.ChangeFeed._heartbeat();
		}
		assert.equal(Zotero.Server.LocalAPI.ChangeFeed._subscriberCount(), 0);
	});

	it("should prefer since and reject invalid resume cursors before opening a stream", async function () {
		try {
			await Zotero.HTTP.request('GET', apiRoot + '/users/0/changefeed?since=not-a-version', {
				headers: {
					'Last-Event-ID': '1',
					'Zotero-Allowed-Request': '1'
				}
			});
			assert.fail('Expected an invalid cursor response');
		}
		catch (e) {
			assert.equal(e.status, 400);
		}
	});
});

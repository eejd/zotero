/*
	***** BEGIN LICENSE BLOCK *****

	Copyright © 2026 Corporation for Digital Scholarship
	                 Vienna, Virginia, USA
	                 http://zotero.org

	This file is part of Zotero.

	Zotero is free software: you can redistribute it and/or modify
	it under the terms of the GNU Affero General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.

	Zotero is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
	GNU Affero General Public License for more details.

	You should have received a copy of the GNU Affero General Public License
	along with Zotero. If not, see <http://www.gnu.org/licenses/>.

	***** END LICENSE BLOCK *****
*/

"use strict";

/*
Phase 3 change feed for the native-split oracle.

Local edits deliberately do not advance Zotero.Library#libraryVersion: that value belongs to the
sync protocol, and changing it locally would desynchronize the existing JS sync engine. ChangeEvent
versions and SSE ids remain the actual libraryVersion required by ADR-0008. An explicit resume
therefore replays events at the resume version as well as later versions: local edits can share a
version, so at-least-once delivery is the only way to avoid silently dropping one of them.

The replay log is process-local and begins when the first subscriber connects. Reconnects during a
running Zotero session are lossless; after an application restart clients must perform their normal
full refresh before subscribing again.
*/

Zotero.Server.LocalAPI.ChangeFeed = new function () {
	const HEARTBEAT_INTERVAL = 15000;
	const MAX_REPLAY_EVENTS = 10000;
	const EVENTS = new Set(['add', 'modify', 'delete', 'trash', 'remove', 'move']);
	const TYPES = new Set([
		'item',
		'collection',
		'search',
		'item-tag',
		'collection-item',
		'tag',
		'setting',
		'group'
	]);

	let observerID;
	let heartbeatTimer;
	let states = new Map();

	function getState(libraryID) {
		let state = states.get(libraryID);
		if (!state) {
			state = {
				events: [],
				subscribers: new Set()
			};
			states.set(libraryID, state);
		}
		return state;
	}

	function ensureObserver() {
		if (!observerID) {
			observerID = Zotero.Notifier.registerObserver(
				this,
				Array.from(TYPES),
				'localAPIChangeFeed'
			);
		}
	}

	function hasSubscribers() {
		return Array.from(states.values()).some(state => state.subscribers.size);
	}

	function stopHeartbeatIfIdle() {
		if (heartbeatTimer && !hasSubscribers()) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		}
	}

	function removeSubscriber(state, subscriber) {
		state.subscribers.delete(subscriber);
		stopHeartbeatIfIdle();
	}

	function startHeartbeat() {
		if (!heartbeatTimer) {
			heartbeatTimer = setInterval(() => this._heartbeat(), HEARTBEAT_INTERVAL);
		}
	}

	function getObject(type, id) {
		switch (type) {
			case 'item': return Zotero.Items.get(id);
			case 'collection': return Zotero.Collections.get(id);
			case 'search': return Zotero.Searches.get(id);
			default: return false;
		}
	}

	function addChange(changes, libraryID, key) {
		libraryID = parseInt(libraryID);
		if (!libraryID || key === undefined || key === null) return;
		let keys = changes.get(libraryID);
		if (!keys) {
			keys = new Set();
			changes.set(libraryID, keys);
		}
		keys.add(String(key));
	}

	function changesForNotifierEvent(type, ids, extraData) {
		let changes = new Map();
		for (let id of ids) {
			let data = extraData && extraData[id];
			if (['item', 'collection', 'search'].includes(type)) {
				let object = getObject(type, id);
				addChange(
					changes,
					data && data.libraryID || object && object.libraryID,
					data && data.key || object && object.key
				);
			}
			else if (type == 'setting') {
				let separator = String(id).indexOf('/');
				if (separator !== -1) {
					addChange(changes, String(id).slice(0, separator), String(id).slice(separator + 1));
				}
			}
			else if (type == 'item-tag') {
				let itemID = parseInt(String(id).split('-')[0]);
				let item = Zotero.Items.get(itemID);
				if (item) {
					let tag = data && data.tag || String(id).slice(String(id).indexOf('-') + 1);
					addChange(changes, data && data.libraryID || item.libraryID, `${item.key}-${tag}`);
				}
			}
			else if (type == 'collection-item') {
				let [collectionID, itemID] = String(id).split('-').map(value => parseInt(value));
				let collection = Zotero.Collections.get(collectionID);
				let item = Zotero.Items.get(itemID);
				if (collection && item) {
					addChange(changes, item.libraryID, `${collection.key}-${item.key}`);
				}
			}
			else if (type == 'group') {
				let group = Zotero.Groups.get(id);
				addChange(changes, data && data.libraryID || group && group.libraryID, id);
			}
			else if (type == 'tag') {
				// Tags are global in Zotero's data model. A tag purge does not include library data,
				// so notify every library whose feed has been active during this process.
				let key = data && data.old && data.old.tag || id;
				for (let libraryID of states.keys()) {
					addChange(changes, libraryID, key);
				}
			}
		}
		return changes;
	}

	function formatEvent(changeEvent) {
		return `id: ${changeEvent.version}\n`
			+ `event: change\n`
			+ `data: ${JSON.stringify(changeEvent)}\n\n`;
	}

	function publish(libraryID, event, type, keys) {
		dump(`CFFEED publish library=${libraryID} event=${event} type=${type} keys=${Array.from(keys)}\n`);
		let state = getState(libraryID);
		let library = Zotero.Libraries.get(libraryID);
		let version = library && library.libraryVersion;
		if (!Number.isInteger(version)) return;
		let changeEvent = {
			event,
			type,
			keys: Array.from(keys),
			version,
			libraryID
		};
		state.events.push(changeEvent);
		if (state.events.length > MAX_REPLAY_EVENTS) {
			state.events.splice(0, state.events.length - MAX_REPLAY_EVENTS);
		}

		let frame = formatEvent(changeEvent);
		for (let subscriber of Array.from(state.subscribers)) {
			if (!subscriber.stream.write(frame)) {
				removeSubscriber(state, subscriber);
			}
		}
	}

	this.notify = function (event, type, ids, extraData) {
		dump(`CFFEED notify event=${event} type=${type} ids=${ids}\n`);
		if (!EVENTS.has(event) || !TYPES.has(type)) return;
		let changes = changesForNotifierEvent(type, ids, extraData || {});
		for (let [libraryID, keys] of changes) {
			publish(libraryID, event, type, keys);
		}
	};

	this.subscribe = function (libraryID, since, includeResumeVersion, stream) {
		ensureObserver.call(this);
		let state = getState(libraryID);
		let subscriber = { stream };
		state.subscribers.add(subscriber);
		stream.addCloseListener(() => removeSubscriber(state, subscriber));
		startHeartbeat.call(this);
		// Do not report the connection as ready until the notifier observer and subscriber are
		// registered. Otherwise a client can receive this frame, perform a write immediately, and
		// lose the resulting notification before subscribe() finishes.
		if (!stream.write(': connected\n\n')) {
			removeSubscriber(state, subscriber);
			return subscriber;
		}

		for (let changeEvent of state.events) {
			if ((changeEvent.version > since
					|| (includeResumeVersion && changeEvent.version === since))
					&& !stream.write(formatEvent(changeEvent))) {
				break;
			}
		}
		return subscriber;
	};

	this._heartbeat = function () {
		for (let state of states.values()) {
			for (let subscriber of Array.from(state.subscribers)) {
				if (!subscriber.stream.write(': heartbeat\n\n')) {
					removeSubscriber(state, subscriber);
				}
			}
		}
	};

	this._subscriberCount = function () {
		return Array.from(states.values())
			.reduce((count, state) => count + state.subscribers.size, 0);
	};

	this._reset = function () {
		if (observerID) {
			Zotero.Notifier.unregisterObserver(observerID);
			observerID = undefined;
		}
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		}
		for (let state of states.values()) {
			for (let subscriber of Array.from(state.subscribers)) {
				subscriber.stream.close();
			}
		}
		states.clear();
	};
};

Zotero.Server.LocalAPI.ChangeFeedEndpoint = class extends Zotero.Server.LocalAPI.Endpoint {
	supportedMethods = ['GET'];

	async run(requestData) {
		let explicitResume = requestData.searchParams.has('since')
			|| requestData.headers.has('Last-Event-ID');
		let sinceValue = requestData.searchParams.has('since')
			? requestData.searchParams.get('since')
			: requestData.headers.get('Last-Event-ID');
		if (sinceValue === null) {
			sinceValue = String(Zotero.Libraries.get(requestData.libraryID).libraryVersion);
		}
		let since = Number(sinceValue);
		if (!/^\d+$/.test(sinceValue) || !Number.isSafeInteger(since)) {
			return this.makeResponse(400, 'text/plain', `Invalid changefeed cursor '${sinceValue}'`);
		}
		let [, headers] = this.makeResponse(200, {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive'
		}, '');
		let stream = requestData.startStreamingResponse(200, headers);
		Zotero.Server.LocalAPI.ChangeFeed.subscribe(
			requestData.libraryID, since, explicitResume, stream
		);
	}
};

Zotero.Server.Endpoints["/api/users/:userID/changefeed"]
	= Zotero.Server.LocalAPI.ChangeFeedEndpoint;
Zotero.Server.Endpoints["/api/groups/:groupID/changefeed"]
	= Zotero.Server.LocalAPI.ChangeFeedEndpoint;

if (Zotero.addShutdownListener) {
	Zotero.addShutdownListener(() => Zotero.Server.LocalAPI.ChangeFeed._reset());
}

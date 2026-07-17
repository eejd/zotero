/*
	***** BEGIN LICENSE BLOCK *****

	Copyright © 2026 eejd

	This file is part of the zotero native-split fork.

	Zotero is free software: you can redistribute it and/or modify
	it under the terms of the GNU Affero General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.

	***** END LICENSE BLOCK *****
*/

"use strict";

const CHANGEFEED_EVENTS = new Set(['add', 'modify', 'delete', 'trash', 'remove', 'move']);
const CHANGEFEED_TYPES = [
	'item', 'collection', 'search', 'item-tag', 'collection-item', 'tag', 'setting', 'group'
];
const CHANGEFEED_HISTORY_LIMIT = 1000;
const CHANGEFEED_HEARTBEAT_INTERVAL = 15000;

/**
 * Process-wide notifier bridge. Keeping one observer alive lets a reconnecting client replay
 * changes that occurred while no HTTP connection was open. HTTP subscribers and their heartbeat
 * timers are still removed immediately when their stream closes.
 */
Zotero.Server.LocalAPI.Changefeed = new class {
	constructor() {
		this._history = new Map();
		this._subscribers = new Map();
		this._nextSubscriberID = 1;
		this.heartbeatInterval = CHANGEFEED_HEARTBEAT_INTERVAL;
		this._observerID = Zotero.Notifier.registerObserver(this, CHANGEFEED_TYPES, 'localAPIChangefeed');
	}

	async notify(event, type, ids, extraData = {}) {
		if (!CHANGEFEED_EVENTS.has(event)) return;
		let changes = new Map();
		for (let id of ids) {
			let resolved = this._resolveObject(type, id, extraData);
			if (!resolved || !resolved.libraryID || !resolved.key) continue;
			let keys = changes.get(resolved.libraryID) || [];
			keys.push(String(resolved.key));
			changes.set(resolved.libraryID, keys);
		}

		for (let [libraryID, keys] of changes) {
			let version = Zotero.Libraries.get(libraryID)?.libraryVersion;
			if (!Number.isInteger(version)) continue;
			let change = { event, type, keys: [...new Set(keys)], version, libraryID };
			this._record(change);
			for (let subscriber of this._subscribers.values()) {
				if (subscriber.libraryID === libraryID) subscriber.send(change);
			}
		}
	}

	_resolveObject(type, id, extraData) {
		let data = extraData[id] || {};
		if (data.libraryID && data.key) return data;

		let objects = {
			item: Zotero.Items,
			collection: Zotero.Collections,
			search: Zotero.Searches,
		};
		let object = objects[type]?.get(id);
		if (object) return { libraryID: object.libraryID, key: object.key };

		if (type === 'group') {
			let group = Zotero.Groups.get(id);
			if (group) return { libraryID: group.libraryID, key: group.id };
		}
		if (type === 'setting' && typeof id === 'string') {
			let [libraryID, ...key] = id.split('/');
			if (/^\d+$/.test(libraryID) && key.length) {
				return { libraryID: parseInt(libraryID), key: key.join('/') };
			}
		}

		// Relationship notifier IDs begin with an item/collection ID. Preserve the complete ID as
		// the relationship key while using the first object to determine library ownership.
		if (['item-tag', 'collection-item', 'tag'].includes(type)) {
			let firstID = parseInt(String(id).split('-')[0]);
			let parent = type === 'collection-item'
				? Zotero.Collections.get(firstID)
				: Zotero.Items.get(firstID);
			if (parent) return { libraryID: parent.libraryID, key: String(id) };
		}
		return null;
	}

	_record(change) {
		let history = this._history.get(change.libraryID) || [];
		history.push(change);
		if (history.length > CHANGEFEED_HISTORY_LIMIT) {
			history.splice(0, history.length - CHANGEFEED_HISTORY_LIMIT);
		}
		this._history.set(change.libraryID, history);
	}

	subscribe(libraryID, since, includeResumeVersion, send) {
		for (let change of this._history.get(libraryID) || []) {
			// Local unsynced edits intentionally do not advance libraryVersion. On an explicit
			// resume, replay the resume version too: duplicates are preferable to silently losing
			// a later local edit that shares the same actual library version.
			if ((change.version > since || (includeResumeVersion && change.version === since))
					&& !send(change)) {
				return () => {};
			}
		}
		let id = this._nextSubscriberID++;
		this._subscribers.set(id, { libraryID, send });
		return () => this._subscribers.delete(id);
	}

	_resetForTests() {
		this._history.clear();
	}
}();

Zotero.Server.LocalAPI.ChangefeedEndpoint = class extends Zotero.Server.LocalAPI.Endpoint {
	supportedMethods = ['GET'];

	streamResponse = true;

	run(requestData) {
		let explicitResume = requestData.searchParams.has('since')
			|| requestData.headers.has('Last-Event-ID');
		let sinceValue = requestData.searchParams.has('since')
			? requestData.searchParams.get('since')
			: requestData.headers.get('Last-Event-ID');
		let since = sinceValue === null ? Zotero.Libraries.get(requestData.libraryID).libraryVersion : Number(sinceValue);
		if (!Number.isInteger(since) || since < 0) {
			return this.makeResponse(400, 'text/plain', `Invalid changefeed version '${sinceValue}'`);
		}

		let stream = requestData.stream;
		stream.start(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			'Zotero-API-Version': 3,
			'Zotero-Schema-Version': Zotero.Schema.globalSchemaVersion,
		});
		stream.write(': connected\n\n');

		let send = change => stream.write(
			`id: ${change.version}\nevent: change\ndata: ${JSON.stringify(change)}\n\n`
		);
		let unsubscribe = () => {};
		let heartbeat;
		stream.onClose(() => {
			if (heartbeat) clearInterval(heartbeat);
			unsubscribe();
		});
		unsubscribe = Zotero.Server.LocalAPI.Changefeed.subscribe(
			requestData.libraryID, since, explicitResume, send
		);
		if (!stream.closed) {
			heartbeat = setInterval(
				() => stream.write(': heartbeat\n\n'),
				Zotero.Server.LocalAPI.Changefeed.heartbeatInterval
			);
		}
		return { streaming: true };
	}
};

Zotero.Server.Endpoints['/api/users/:userID/changefeed'] = Zotero.Server.LocalAPI.ChangefeedEndpoint;
Zotero.Server.Endpoints['/api/groups/:groupID/changefeed'] = Zotero.Server.LocalAPI.ChangefeedEndpoint;

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import core from '../shared/journal-core.cjs';
import versionCore from '../shared/version-history.cjs';

const source = await fs.readFile(new URL('../renderer/shared-folder.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred()
{
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	return {promise, resolve};
}
function harness(transport)
{
	const elements = [];
	const node = () => ({style: {cssText: ''}, children: [], attrs: {},
		appendChild(child) { this.children.push(child); }, insertBefore() {}, replaceChildren() {}, addEventListener() {},
		setAttribute(name, value) { this.attrs[name] = value; }, getAttribute(name) { return this.attrs[name] ?? null; },
		removeAttribute(name) { delete this.attrs[name]; }});
	const ui = {current: null, pages: {}, fileNode: node(), enabled: true, errors: [],
		editor: {graph: {isEditing: () => false, stopEditing() {}, getSelectionCells: () => []}, addListener() {}, setStatus() {}},
		getCurrentFile() { return this.current; }, getFileData() { return JSON.stringify(this.pages); },
		clonePages: value => structuredClone(value), getPagesForXml: value => JSON.parse(value),
		diffPages: (before, after) => JSON.stringify(before) === JSON.stringify(after) ? {} : {pages: after},
		patchPages: (before, patch) => structuredClone(patch.pages || before), getNodeForPages: pages => Object.assign(node(), {pages}),
		setGraphEnabled(value) { this.enabled = value; }, descriptorChanged() {}, handleError(error) { this.errors.push(error); }};
	class LocalFile
	{
		constructor(filename, editable = true) { this.fileObject = filename && {path: filename}; this.editable = editable; this.cleared = []; }
		isEditable() { return this.editable; }
		isAutosave() { return true; }
		clearAutosave() {}
		save(_revision, success) { success?.(); }
		synchronizeFile(success) { success?.(); }
		patch(patches) { for (const patch of patches) if (patch.pages) ui.pages = structuredClone(patch.pages); }
		setModified(value) { if (!value) this.cleared.push(ui.current); }
		setShadowPages() {}
		setData() {}
	}
	const context = {window: {ShareMapJournal: core, ShareMapVersions: versionCore, crypto: globalThis.crypto, addEventListener() {}},
		document: {body: node(), createElement() { const result = node(); elements.push(result); return result; }},
		Draw: {loadPlugin: fn => fn(ui)}, LocalFile,
		// Answers watch like a server without push updates, so tests drive sync explicitly.
		electron: {sharedFolder: request => request.action === 'watch' ? Promise.reject(new Error('Endpoint not found')) : transport(request)},
		mxUtils: {isEmptyObject: value => Object.keys(value).length === 0, parseXml: () => ({documentElement: node()}), getXml: value => value.pages ? JSON.stringify(value.pages) : 'snapshot'},
		localStorage: {getItem: () => ''}, setInterval: () => 1, clearInterval() {}, console};
	vm.runInNewContext(source, context);
	return {ui, LocalFile, elements, select(file, pages = {}) { ui.current = file; ui.pages = pages; ui.fileNode = node(); }};
}
function server()
{
	const calls = [];
	const handler = async request =>
	{
		calls.push(request);
		if (request.action === 'open') return {id: randomUUID(), author: randomUUID(), manifest: {room: randomUUID(), base: '{}'}, name: 'Test'};
		if (request.action === 'scan') return {records: [], peers: []};
		if (request.action === 'activity') return [];
		if (request.action === 'snapshot' || request.action === 'close') return true;
		if (request.action === 'append') return {version: 1, room: handler.room, id: randomUUID(), author: randomUUID(), clock: 1, parents: [], patch: request.patch};
	};
	return {handler, calls};
}

test('switching documents while probing guards and opens the new file', async () =>
{
	const gate = deferred();
	const s = server();
	const h = harness(request => request.action === 'open' && request.path === 'a.drawio' ? gate.promise : s.handler(request));
	const a = new h.LocalFile('a.drawio');
	const b = new h.LocalFile('b.drawio');
	h.select(a);
	const first = h.ui.sharedFolder.open();
	h.select(b);
	const second = h.ui.sharedFolder.open();
	assert.equal(b.isAutosave(), false);
	gate.resolve(null);
	await Promise.all([first, second]);
	assert.equal(h.ui.sharedFolder.getSession().file, b);
	assert.equal(h.ui.enabled, true);
});

test('a snapshot completing after a switch cannot clear state on the new canvas', async () =>
{
	const gate = deferred();
	const entered = deferred();
	const s = server();
	let firstSnapshot = true;
	const h = harness(request =>
	{
		if (request.action === 'snapshot' && firstSnapshot) { firstSnapshot = false; entered.resolve(); return gate.promise; }
		return s.handler(request);
	});
	const a = new h.LocalFile('a.drawio');
	h.select(a);
	const first = h.ui.sharedFolder.open();
	await entered.promise;
	const b = new h.LocalFile('b.drawio');
	h.select(b);
	const second = h.ui.sharedFolder.open();
	gate.resolve(true);
	await Promise.all([first, second]);
	assert.equal(a.cleared.every(file => file === a), true);
	assert.equal(h.ui.sharedFolder.getSession().file, b);
});

test('manual Save reports a document switch instead of dereferencing another session', async () =>
{
	const gate = deferred();
	const entered = deferred();
	const s = server();
	let hold = false;
	const h = harness(request =>
	{
		if (hold && request.action === 'scan') { entered.resolve(); return gate.promise; }
		return s.handler(request);
	});
	const a = new h.LocalFile('a.drawio');
	h.select(a);
	await h.ui.sharedFolder.open();
	hold = true;
	const saved = new Promise(resolve => a.save(false, () => resolve(null), resolve));
	await entered.promise;
	h.select(new h.LocalFile(null));
	await h.ui.sharedFolder.open();
	gate.resolve({records: []});
	assert.match((await saved).message, /document changed/);
});

test('the first normal save discovers collaboration without reopening', async () =>
{
	const s = server();
	const h = harness(s.handler);
	const a = new h.LocalFile(null);
	h.select(a);
	a.fileObject = {path: 'new-map.drawio'};
	await new Promise(resolve => a.save(false, resolve));
	for (let count = 0; count < 10 && !h.ui.sharedFolder.getSession()?.initialized; count++) await tick();
	assert.equal(h.ui.sharedFolder.getSession().file, a);
	assert.equal(s.calls.filter(request => request.action === 'open').length, 1);
});

test('version history replays each version from the journal and restores it as a new published edit', async () =>
{
	const room = randomUUID();
	const start = Date.UTC(2026, 9, 29, 9);
	const first = {version: 1, room, id: randomUUID(), author: randomUUID(), name: 'Alice', clock: 1, time: start, parents: [], patch: {pages: {desk: 'one'}}};
	const second = {version: 1, room, id: randomUUID(), author: randomUUID(), name: 'Bob', clock: 2, time: start + 20 * 60 * 1000, parents: [first.id], patch: {pages: {desk: 'two'}}};
	const records = [first, second];
	const appended = [];
	const h = harness(async request =>
	{
		if (request.action === 'open') return {id: randomUUID(), author: randomUUID(), transport: 'server', manifest: {room, base: '{"desk":"base"}'}, name: 'Test'};
		if (request.action === 'scan') return {records, peers: []};
		if (request.action === 'history') return {created: start - 1000, times: {}};
		if (request.action === 'append')
		{
			const op = {version: 1, room, id: request.operationId, author: randomUUID(), name: request.name, clock: records.length + 1, time: Date.now(), parents: request.parents, patch: request.patch};
			appended.push(op);
			records.push(op);
			return op;
		}
		if (request.action === 'activity') return [];
		return true;
	});
	const file = new h.LocalFile('map.drawio');
	h.select(file);
	await h.ui.sharedFolder.open();
	assert.deepEqual(h.ui.pages, {desk: 'two'});
	assert.equal(file.isRevisionHistorySupported(), true);
	const revs = await new Promise((resolve, reject) => file.getRevisions(resolve, reject));
	assert.deepEqual(revs.map(rev => [rev.lastModifyingUserName, rev.modifiedDate]),
		[['Shared diagram created', start - 1000], ['Alice', first.time], ['Bob', second.time]]);
	const xmlOf = rev => new Promise((resolve, reject) => rev.getXml(resolve, reject));
	assert.equal(await xmlOf(revs[0]), '{"desk":"base"}');
	assert.equal(await xmlOf(revs[2]), '{"desk":"two"}');
	assert.equal(await xmlOf(revs[1]), '{"desk":"one"}', 'an older version replays again from the base');
	await h.ui.sharedFolder.restoreVersion(await xmlOf(revs[1]));
	assert.deepEqual(h.ui.pages, {desk: 'one'});
	assert.equal(appended.length, 1);
	assert.deepEqual(appended[0].patch, {pages: {desk: 'one'}});
	assert.deepEqual(appended[0].parents, [second.id]);
	assert.equal(records.length, 3, 'earlier versions stay in the journal');
});

test('a view link opens read-only and never publishes or writes snapshots', async () =>
{
	const room = randomUUID();
	const calls = [];
	const h = harness(async request =>
	{
		calls.push(request.action);
		if (request.action === 'open') return {id: randomUUID(), author: randomUUID(), transport: 'server', role: 'view', manifest: {room, base: '{"desk":"base"}'}, name: 'Viewer'};
		if (request.action === 'scan') return {records: [], peers: []};
		return [];
	});
	const file = new h.LocalFile('map.drawio');
	h.select(file);
	await h.ui.sharedFolder.open();
	assert.equal(h.ui.enabled, false);
	h.ui.pages = {desk: 'changed locally'};
	await h.ui.sharedFolder.cycle();
	assert.equal(calls.includes('append'), false);
	assert.equal(calls.includes('snapshot'), false);
});

test('a local edit that lands last on the server is not replayed from the journal', async () =>
{
	const room = randomUUID();
	const records = [];
	const h = harness(async request =>
	{
		if (request.action === 'open') return {id: randomUUID(), author: randomUUID(), transport: 'server', manifest: {room, base: '{"desk":"base"}'}, name: 'Test'};
		if (request.action === 'scan') return {records, peers: []};
		if (request.action === 'append')
		{
			const op = {version: 1, room, id: request.operationId, author: randomUUID(), name: request.name, clock: records.length + 1, time: Date.now(), parents: request.parents, patch: request.patch};
			records.push(op);
			return op;
		}
		return true;
	});
	const file = new h.LocalFile('map.drawio');
	h.select(file);
	await h.ui.sharedFolder.open();
	let replays = 0;
	const patchPages = h.ui.patchPages;
	h.ui.patchPages = function() { replays++; return patchPages.apply(this, arguments); };
	for (const value of ['one', 'two', 'three'])
	{
		h.ui.pages = {desk: value};
		await h.ui.sharedFolder.cycle();
	}
	assert.equal(records.length, 3);
	assert.equal(replays, 0);
	assert.deepEqual(h.ui.sharedFolder.getSession().applied, records.map(op => op.id));
});

test('reopening starts from this desktop\'s saved state and replays only newer edits', async () =>
{
	const room = randomUUID();
	const op = (clock, value, parents) => ({version: 1, room, id: randomUUID(), author: randomUUID(), name: 'Ann', clock, time: clock, parents, patch: {pages: {desk: value}}});
	const first = op(1, 'one', []), second = op(2, 'two', [first.id]), third = op(3, 'three', [second.id]);
	let launch = {room, count: 2, last: second.id, xml: '{"desk":"two"}'};
	const h = harness(async request =>
	{
		if (request.action === 'open') return {id: randomUUID(), author: randomUUID(), transport: 'server', manifest: {room, base: '{"desk":"base"}'}, name: 'Test'};
		if (request.action === 'scan') return {records: [first, second, third], peers: []};
		if (request.action === 'launchState') return launch;
		return true;
	});
	let replays = 0;
	const patchPages = h.ui.patchPages;
	h.ui.patchPages = function() { replays++; return patchPages.apply(this, arguments); };
	h.select(new h.LocalFile('map.drawio'));
	await h.ui.sharedFolder.open();
	assert.deepEqual(h.ui.pages, {desk: 'three'});
	assert.equal(replays, 1);
	launch = {room, count: 2, last: randomUUID(), xml: '{"desk":"stale"}'};
	replays = 0;
	h.select(new h.LocalFile('other.drawio'));
	await h.ui.sharedFolder.open();
	assert.deepEqual(h.ui.pages, {desk: 'three'});
	assert.equal(replays, 3, 'a saved state that does not match the journal is ignored');
});

test('read-only documents stay read-only and never start a writable journal', async () =>
{
	const s = server();
	const h = harness(s.handler);
	h.select(new h.LocalFile('readonly.drawio', false));
	h.ui.enabled = false;
	await h.ui.sharedFolder.open();
	assert.equal(h.ui.enabled, false);
	assert.equal(s.calls.length, 0);
});

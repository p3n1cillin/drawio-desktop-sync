import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import core from '../shared/journal-core.cjs';

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
		patchPages: (before, patch) => structuredClone(patch.pages || before), getNodeForPages: node,
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
	const context = {window: {ShareMapJournal: core, addEventListener() {}},
		document: {body: node(), createElement() { const result = node(); elements.push(result); return result; }},
		Draw: {loadPlugin: fn => fn(ui)}, LocalFile, electron: {sharedFolder: transport},
		mxUtils: {isEmptyObject: value => Object.keys(value).length === 0, parseXml: () => ({documentElement: node()}), getXml: () => 'snapshot'},
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
		if (request.action === 'scan' || request.action === 'activity') return [];
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
	gate.resolve([]);
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

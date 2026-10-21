import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {registerSharedFolder} from '../main/shared-folder-ipc.js';

function fixture(options = {})
{
	let handler, copied, leaves = 0, shortcuts = 0, blessed = 0, rotations = 0;
	const sender = new EventEmitter(); sender.mainFrame = {};
	let throttling = true;
	sender.isDestroyed = () => false;
	sender.getBackgroundThrottling = () => throttling;
	sender.setBackgroundThrottling = value => { throttling = value; };
	const event = {sender, senderFrame: sender.mainFrame};
	const folder = {filename: 'shared.drawio', connection: {server: 'https://example.test'}, peers: [], stats: {requests: 1},
		open: async () => ({manifest: {room: randomUUID(), base: 'private diagram'}, transport: 'server'}),
		leave: async () => { leaves++; }, updates: async () => [],
		shareLink: async () => 'drawio-sync://join/credential', rotateLink: async () => { rotations++; return true; },
		diagnostics: async () => ({room: 'room', edits: {count: 0}, presence: [], transport: 'server'})};
	registerSharedFolder({ipcMain: {handle: (_channel, callback) => { handler = callback; }},
		clientBuild: 'test-build',
		validateSender: frame => frame === sender.mainFrame, assertWritablePath: async () => {},
		clipboard: {writeText: value => { copied = value; }},
		serverMaps: {open: async filename => filename === 'ordinary.drawio' ? null : folder, join: async () => folder.filename, create: async () => folder.filename},
		confirmServer: async () => true, blessServerMap: () => { blessed++; }, createShortcut: () => { shortcuts++; }, ...options});
	return {folder, event, sender, copied: () => copied, counts: () => ({leaves, shortcuts, blessed, rotations}), call: request => handler(event, request)};
}
test('subframes cannot invoke collaboration IPC', async () =>
{
	const h = fixture(); h.event.senderFrame = {};
	await assert.rejects(h.call({action: 'open', path: 'shared.drawio'}), /denied/);
});
test('ordinary local diagrams do not enable a sharing transport or change throttling', async () =>
{
	const h = fixture();
	assert.equal(await h.call({action: 'open', path: 'ordinary.drawio'}), null);
	assert.equal(h.sender.getBackgroundThrottling(), true);
});
test('path authorization is required before opening and saving a shared map', async () =>
{
	const h = fixture({assertWritablePath: async () => { throw new Error('denied path'); }});
	await assert.rejects(h.call({action: 'open', path: 'shared.drawio'}), /denied path/);
});
test('background polling remains enabled until the last window session closes', async () =>
{
	const h = fixture();
	const a = await h.call({action: 'open', path: 'shared.drawio'});
	const b = await h.call({action: 'open', path: 'shared.drawio'});
	assert.equal(h.sender.getBackgroundThrottling(), false);
	await h.call({action: 'close', id: a.id}); assert.equal(h.sender.getBackgroundThrottling(), false);
	await h.call({action: 'close', id: b.id}); assert.equal(h.sender.getBackgroundThrottling(), true);
	assert.equal(h.counts().leaves, 2);
});
test('destroying an editor removes all of its presence sessions', async () =>
{
	const h = fixture(); await h.call({action: 'open', path: 'shared.drawio'});
	h.sender.emit('destroyed'); await new Promise(resolve => setImmediate(resolve));
	assert.equal(h.counts().leaves, 1);
});
test('joining requires native consent, then blesses only the returned cache and creates a shortcut', async () =>
{
	const denied = fixture({confirmServer: async () => false});
	await assert.rejects(denied.call({action: 'serverJoin', invite: 'invite'}), /cancelled/);
	assert.equal(denied.counts().blessed, 0);
	const h = fixture(); await h.call({action: 'serverJoin', invite: 'invite'});
	assert.equal(h.counts().blessed, 1); assert.equal(h.counts().shortcuts, 1);
});
test('revoking links requires native consent', async () =>
{
	const h = fixture({confirmServer: async () => false});
	const info = await h.call({action: 'open', path: 'shared.drawio'});
	await assert.rejects(h.call({action: 'rotateLink', id: info.id}), /cancelled/);
	assert.equal(h.counts().rotations, 0);
});
test('an unavailable desktop shortcut does not prevent joining a saved server map', async () =>
{
	const h = fixture({createShortcut: () => { throw new Error('Desktop unavailable'); }});
	const result = await h.call({action: 'serverJoin', invite: 'invite'});
	assert.equal(result.path, 'shared.drawio'); assert.equal(result.shortcutCreated, false);
});
test('diagnostics include connection timing, sanitize renderer state and exclude diagram content', async () =>
{
	const h = fixture(); const info = await h.call({action: 'open', path: 'shared.drawio'});
	const report = await h.call({action: 'diagnostics', id: info.id, copy: true, editor: {initialized: true, error: 'x'.repeat(2000), xml: 'private diagram'}});
	assert.equal(report.editor.error.length, 1000); assert.equal(report.clientBuild, 'test-build');
	assert.equal(report.connection.requests, 1); assert.equal(report.editor.xml, undefined);
	assert.equal(h.copied().includes('private diagram'), false);
});

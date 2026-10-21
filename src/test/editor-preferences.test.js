import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {EditorPreferences, isPreferenceKey, registerEditorPreferences} from '../main/editor-preferences.js';

function fixture()
{
	let saved = {};
	let writes = 0;
	const store = {get: key => structuredClone(saved[key]), set(key, value) { saved[key] = structuredClone(value); writes++; }};
	return {store, get writes() { return writes; }, preferences: new EditorPreferences(store)};
}
test('configuration, named profiles and editor preferences survive a new store instance', () =>
{
	const f = fixture();
	const entries = {'.configuration': JSON.stringify({zoomWheel: false, enablePositionGuides: true}),
		'.drawio-config': JSON.stringify({darkMode: '1', language: 'en', customLibraries: ['Sexample']}),
		'.team-configuration': '{"gridSteps":8}', '.sharemapName': 'User'};
	f.preferences.writeMany(entries);
	assert.deepEqual(new EditorPreferences(f.store).read(), entries);
	f.preferences.writeMany(entries);
	assert.equal(f.writes, 1, 'unchanged settings do not cause extra disk writes');
});
test('reset is durable, including when an old editor cache still has the setting', () =>
{
	const f = fixture();
	f.preferences.write('.configuration', '{"compact":true}');
	f.preferences.write('.configuration', null);
	assert.deepEqual(new EditorPreferences(f.store).read(), {'.configuration': null});
});
test('backup accepts preferences but excludes diagram content, drafts and login tokens', () =>
{
	for (const key of ['.configuration', '.drawio-config', '.sharemapReviewed.' + randomUUID(), '.lastSaveDir', '.drawio-elk-layout-settings']) assert.ok(isPreferenceKey(key));
	for (const key of ['map.drawio', '.draft-map', 'connection.json', 'drawio_trello_token', '__proto__', 'entries', 'adminToken']) assert.equal(isPreferenceKey(key), false);
	const f = fixture();
	assert.throws(() => f.preferences.writeMany({'.configuration': '{}', adminToken: 'secret'}));
	assert.deepEqual(f.preferences.read(), {}, 'invalid batches never partially persist');
	assert.throws(() => f.preferences.write('.configuration', 'x'.repeat(2 * 1024 * 1024 + 1)));
	assert.throws(() => f.preferences.write('.configuration', {}));
});
test('only a trusted main frame can read or change persisted editor preferences', () =>
{
	const f = fixture();
	let handler;
	registerEditorPreferences({ipcMain: {on(_channel, fn) { handler = fn; }}, validateSender: frame => frame?.trusted === true, preferences: f.preferences});
	const frame = {trusted: true};
	const sender = {mainFrame: frame};
	const invoke = (senderFrame, request) => { const event = {senderFrame, sender}; handler(event, request); return event.returnValue; };
	assert.ok(invoke({}, {action: 'read'}).error);
	assert.ok(invoke({trusted: true}, {action: 'write', entries: {'.configuration': '{}'}}).error);
	assert.deepEqual(f.preferences.read(), {});
	assert.equal(invoke(frame, {action: 'write', entries: {'.configuration': '{}'}}).saved, true);
	assert.deepEqual(invoke(frame, {action: 'read'}).entries, {'.configuration': '{}'});
});

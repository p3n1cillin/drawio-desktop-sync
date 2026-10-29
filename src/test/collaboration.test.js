import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import changes from '../shared/change-log.cjs';
import core from '../shared/journal-core.cjs';
import {systemIdentity, parseRegistryString, nameFromEmail} from '../main/identity.js';

const room = randomUUID();
let clock = 0;
const op = (patch, name = 'Ann', parents = []) => ({version: 1, room, id: randomUUID(), author: randomUUID(), name, clock: ++clock, time: 1000 + clock, parents, patch});

test('Show Changes describes text, formatting, moves, inserts, deletes and pages with the previous text', () =>
{
	const state = changes.createState({'p\ndesk': 'Desk'}, {p: 'Floor 1'});
	changes.apply(state, [
		op({u: {p: {cells: {u: {desk: {value: '<b>Front</b>&nbsp;desk', style: 'fillColor=red'}}}}}}),
		op({u: {p: {cells: {u: {desk: {geometry: '<mxGeometry/>'}}, i: [{id: 'chair', vertex: 1, xmlValue: '<object label="Chair &amp;amp; table" id="chair"/>'}]}}}}, 'Ben'),
		op({u: {p: {name: 'Ground floor', cells: {r: ['desk']}}}, i: [{id: 'p2', data: '<diagram name="Floor 2" id="p2"/>'}]})]);
	assert.deepEqual(state.entries.map(entry => [entry.author, entry.kind, entry.text]), [
		['Ann', 'text', 'Changed text from "Desk" to "Front desk"; Changed formatting of "Desk"'],
		['Ben', 'add', 'Added shape "Chair & table"'],
		['Ben', 'move', 'Moved or resized "Front desk"'],
		['Ann', 'page-add', 'Added page "Floor 2"'],
		['Ann', 'page-rename', 'Renamed page "Floor 1" to "Ground floor"'],
		['Ann', 'delete', 'Deleted "Front desk"']]);
	assert.equal(state.entries[0].cell, 'desk');
	assert.equal(state.count, 3);
	const count = state.entries.length;
	changes.apply(state, [op({u: {p: {cells: {u: {chair: {source: 'a'}}}}}})]);
	assert.equal(state.entries.length, count + 1, 'later edits are described incrementally');
	assert.equal(state.entries.at(-1).text, 'Reconnected "Chair & table"');
});

test('appending server-ordered edits matches a full ordering, and out-of-order edits fall back', () =>
{
	const first = op({}), second = op({}, 'Ann', [first.id]);
	const ordered = core.order([first], room);
	assert.equal(core.extend(ordered, [second], room), ordered);
	assert.deepEqual(ordered.ready.map(item => item.id), core.order([first, second], room).ready.map(item => item.id));
	assert.deepEqual(ordered.heads, [second.id]);
	const early = {...op({}), clock: 1};
	assert.equal(core.extend(ordered, [early], room), null);
	assert.equal(ordered.ready.length, 2, 'a refused extension changes nothing');
	assert.equal(core.extend(ordered, [op({}, 'Ann', [randomUUID()])], room), null, 'missing parents need a full order');
});

test('identity uses the signed-in account and Office name, with plain fallbacks on any PC', async () =>
{
	const output = {'whoami.exe': 'Jane.Doe@Contoso.example\r\n', 'reg.exe': '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Office\\Common\\UserInfo\r\n    UserName    REG_SZ    Jane Doe\r\n'};
	const exec = async file => output[file.split('\\').at(-1)] || '';
	assert.deepEqual(await systemIdentity({platform: 'win32', exec, username: 'jdoe'}), {name: 'Jane Doe', email: 'jane.doe@contoso.example'});
	delete output['reg.exe'];
	assert.deepEqual(await systemIdentity({platform: 'win32', exec, username: 'jdoe'}), {name: 'Jane Doe', email: 'jane.doe@contoso.example'});
	output['whoami.exe'] = 'ERROR: Unable to get User Principal Name (UPN)';
	assert.deepEqual(await systemIdentity({platform: 'win32', exec, username: 'jdoe'}), {name: 'jdoe', email: ''});
	assert.deepEqual(await systemIdentity({platform: 'linux', username: 'sam'}), {name: 'sam', email: ''});
	assert.equal(parseRegistryString('    UserName    REG_SZ    ', 'UserName'), '');
	assert.equal(nameFromEmail('first-last@x.example'), 'First Last');
});

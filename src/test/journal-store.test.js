import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import core from '../shared/journal-core.cjs';
import {JournalStore} from '../server/journal-store.js';

const xml = '<mxfile><diagram id="page" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
async function fixture(t)
{
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sharemap-test-'));
	t.after(() => fs.rm(dir, {recursive: true, force: true}));
	const filename = path.join(dir, 'map.drawio');
	await fs.writeFile(filename, xml);
	const a = new JournalStore(filename);
	await a.open(xml);
	const b = a;
	return {dir, filename, a, b};
}

test('concurrent independent edits are durable, immutable and converge', async t =>
{
	const {a, b} = await fixture(t);
	const [first, second] = await Promise.all([
		a.append({u: {page: {u: {a: {value: 'Alice'}}}}}, [], 'Alice'),
		b.append({u: {page: {u: {b: {value: 'Bob'}}}}}, [], 'Bob')]);
	assert.notEqual(first.id, second.id);
	assert.equal((await a.scan()).length, 2);
	assert.deepEqual(core.order(await a.scan(), a.manifest.room), core.order(await b.scan(), b.manifest.room));
	const reopened = new JournalStore(a.filename);
	await reopened.open();
	assert.equal((await reopened.scan()).length, 2);
});

test('out of order delivery defers descendants until missing parents arrive', async t =>
{
	const {a} = await fixture(t);
	const parent = await a.append({u: {}}, [], 'a');
	const child = await a.append({u: {}}, [parent.id], 'a');
	assert.equal(core.order([child], a.manifest.room).pending, 1);
	assert.deepEqual(core.order([child, parent], a.manifest.room).ready.map(op => op.id), [parent.id, child.id]);
});

test('same-property edits have identical order regardless of arrival', async t =>
{
	const {a, b} = await fixture(t);
	const left = await a.append({u: {same: {value: 'left'}}}, [], 'left');
	const right = await b.append({u: {same: {value: 'right'}}}, [], 'right');
	assert.deepEqual(core.order([left, right], a.manifest.room).ready, core.order([right, left], a.manifest.room).ready);
});

test('a stale materialized snapshot cannot overwrite newer server edits', async t =>
{
	const {a, b, filename} = await fixture(t);
	await b.append({u: {}}, [], 'Bob');
	assert.equal(await a.snapshot('old snapshot', []), false);
	assert.equal(await fs.readFile(filename, 'utf8'), xml);
});

test('edits from an ordinary editor are preserved and never silently overwritten', async t =>
{
	const {a, filename} = await fixture(t);
	assert.equal(await a.snapshot('<mxfile>first shared snapshot</mxfile>', []), true);
	await fs.writeFile(filename, '<mxfile>external editor changes</mxfile>');
	await assert.rejects(a.snapshot('<mxfile>second shared snapshot</mxfile>', []), /outside collaboration/);
	assert.equal(await fs.readFile(filename, 'utf8'), '<mxfile>external editor changes</mxfile>');
});

test('temporary and unrelated files are ignored; corrupt journal records stop saving', async t =>
{
	const {a} = await fixture(t);
	await fs.writeFile(path.join(a.directory, 'pending-crash.tmp'), '{');
	assert.deepEqual(await a.scan(), []);
	await fs.writeFile(path.join(a.directory, 'edit-broken.json'), '{');
	await assert.rejects(a.scan(true));
});

test('deleted or tampered immutable edits are detected', async t =>
{
	const {a} = await fixture(t);
	const op = await a.append({u: {}}, [], 'Alice');
	const name = path.join(a.directory, 'edit-' + op.id + '.json');
	await fs.writeFile(name, JSON.stringify({...op, patch: {u: {changed: {}}}}));
	await assert.rejects(a.scan(true), /modified/);
	await fs.unlink(name);
	await assert.rejects(a.scan(true), /missing/);
});

test('conflicting manifests are never silently adopted', async t =>
{
	const {a} = await fixture(t);
	await fs.writeFile(path.join(a.directory, 'manifest.json'), JSON.stringify({...a.manifest, room: randomUUID()}));
	await assert.rejects(a.scan(true), /manifest changed/);
});

test('unknown dependencies and invalid clock or foreign-room input cannot be saved', async t =>
{
	const {a} = await fixture(t);
	await assert.rejects(a.append({}, [randomUUID()], 'Alice'), /earlier edits/);
	const op = await a.append({}, [], 'Alice');
	assert.throws(() => core.validate({...op, clock: Infinity}, a.manifest.room));
	assert.throws(() => core.validate({...op, room: randomUUID()}, a.manifest.room));
	assert.throws(() => core.validate({...op, parents: [op.id]}, a.manifest.room));
});

test('initialization never replaces an existing base', async t =>
{
	const {a, filename} = await fixture(t);
	const other = new JournalStore(filename);
	await other.open('new base');
	assert.equal(other.manifest.base, a.manifest.base);
	assert.equal(other.manifest.room, a.manifest.room);
});

test('journal directory redirection is rejected', async t =>
{
	const {a, dir} = await fixture(t);
	const original = a.directory + '-original';
	await fs.rename(a.directory, original);
	const other = path.join(dir, 'other');
	await fs.mkdir(other);
	await fs.symlink(other, a.directory, 'junction');
	await assert.rejects(a.scan(), /Unsafe collaboration/);
});

test('UTF-8 edits over the disk limit are rejected before creating an unreadable record', async t =>
{
	const {a} = await fixture(t);
	await assert.rejects(a.append({value: '地'.repeat(1500000)}, [], 'Alice'), /Invalid shared edit/);
	assert.deepEqual(await a.scan(), []);
	await a.append({value: '地'.repeat(500000)}, [], 'Alice');
	assert.equal((await a.scan()).length, 1);
});

test('a valid large base with JSON escaping can be reopened', async t =>
{
	const {filename, a} = await fixture(t);
	await fs.rm(a.directory, {recursive: true});
	const base = '"'.repeat(9 * 1024 * 1024);
	await a.open(base);
	const reopened = new JournalStore(filename);
	await reopened.open();
	assert.equal(reopened.manifest.base, base);
});

test('reopening an externally changed map stops before replay replaces the canvas', async t =>
{
	const {filename} = await fixture(t);
	const changed = '<mxfile>work saved outside collaboration</mxfile>';
	await fs.writeFile(filename, changed);
	await assert.rejects(new JournalStore(filename).open(), /outside/);
	assert.equal(await fs.readFile(filename, 'utf8'), changed);
});

test('reopening a known materialized snapshot is supported', async t =>
{
	const {a, filename} = await fixture(t);
	await a.snapshot('<mxfile>journal snapshot</mxfile>', []);
	assert.ok(await new JournalStore(filename).open());
});

test('a temporary Windows sync lock is retried without losing the completed snapshot', async t =>
{
	const {a, filename} = await fixture(t);
	const rename = fs.rename;
	let locked = true;
	t.mock.method(fs, 'rename', async (...args) =>
	{
		if (locked)
		{
			locked = false;
			assert.equal(await fs.readFile(filename, 'utf8'), xml);
			throw Object.assign(new Error('File in use'), {code: 'EPERM'});
		}
		return rename(...args);
	});
	assert.equal(await a.snapshot('<mxfile>complete snapshot</mxfile>', []), true);
	assert.equal(await fs.readFile(filename, 'utf8'), '<mxfile>complete snapshot</mxfile>');
});

test('failed durable writes remove their temporary files and leave existing records intact', async t =>
{
	const {a} = await fixture(t);
	const open = fs.open;
	t.mock.method(fs, 'open', async (...args) =>
	{
		const handle = await open(...args);
		return {writeFile: async () => { throw Object.assign(new Error('Disk full'), {code: 'ENOSPC'}); },
			close: () => handle.close()};
	});
	await assert.rejects(a.append({value: 'Unsaved'}, [], 'Alice'), /Disk full/);
	assert.deepEqual((await fs.readdir(a.directory)).filter(name => name.endsWith('.tmp')), []);
	assert.deepEqual(await a.scan(), []);
});


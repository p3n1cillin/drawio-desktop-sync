import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createCollaborationServer} from '../server/server.js';
import {ServerMaps, ServerFolder, serverRequest, shareInvite, parseInvite} from '../main/server-folder.js';
import core from '../shared/journal-core.cjs';

const xml = '<mxfile><diagram id="page"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
export async function fixture(t)
{
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'drawio-server-test-'));
	const cert = await fs.readFile(new URL('./fixtures/sync-tls/cert.pem', import.meta.url));
	const key = await fs.readFile(new URL('./fixtures/sync-tls/key.pem', import.meta.url));
	const adminToken = randomUUID() + randomUUID();
	const options = {directory: path.join(directory, 'data'), key, cert, adminToken};
	let server = await createCollaborationServer(options);
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;
	const setup = {server: 'https://127.0.0.1:' + port, ca: cert.toString(), adminToken};
	const owner = new ServerMaps(path.join(directory, 'owner'));
	await fs.mkdir(path.dirname(owner.setupPath), {recursive: true});
	await fs.writeFile(owner.setupPath, JSON.stringify(setup));
	t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, {force: true, recursive: true}); });
	return {directory, owner, setup, async restart()
	{
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
		server = await createCollaborationServer(options);
		await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
	}};
}

test('server owns a single room shared by separate clients; concurrent edits and presence converge', async t =>
{
	const h = await fixture(t);
	const filename = await h.owner.create({xml, name: 'Office.drawio'});
	const a = await h.owner.open(filename, randomUUID());
	await a.open();
	const peer = new ServerMaps(path.join(h.directory, 'peer'));
	const invitation = await a.shareLink();
	assert.equal(invitation.includes(a.connection.ownerToken), false);
	assert.equal(parseInvite(invitation).ownerToken, undefined);
	const otherFile = await peer.join(invitation);
	const b = await peer.open(otherFile, randomUUID());
	await b.open();
	assert.equal(a.manifest.room, b.manifest.room);
	await Promise.all([a.append({u: {a: {value: 'Alice'}}}, [], 'Alice', randomUUID()), b.append({u: {b: {value: 'Bob'}}}, [], 'Bob', randomUUID())]);
	assert.deepEqual(core.order(await a.scan(), a.manifest.room), core.order(await b.scan(), b.manifest.room));
	await a.activity('Alice', 'page', []);
	assert.equal((await b.activity('Bob', 'page', [])).length, 2);
	await h.restart();
	assert.equal((await a.scan()).length, 2);
	assert.equal((await b.scan()).length, 2);
	await a.leave();
	assert.equal((await b.activity('Bob', 'page', [])).length, 1);
});

test('lost save responses and durable outbox replay do not duplicate an edit', async t =>
{
	const h = await fixture(t);
	const filename = await h.owner.create({xml, name: 'Office.drawio'});
	const a = await h.owner.open(filename, randomUUID());
	await a.open();
	const patch = {u: {a: {value: 'Once'}}};
	const id = randomUUID();
	const first = await a.append(patch, [], 'Alice', id);
	assert.deepEqual(await a.append(patch, [], 'Alice', id), first);
	await assert.rejects(a.append({changed: true}, [], 'Alice', id), /reused/);
	// Simulate process termination after server commit but before local acknowledgement.
	await fs.writeFile(path.join(path.dirname(filename), 'outbox-' + id + '.json'), JSON.stringify({patch, parents: [], name: 'Alice', operationId: id, author: a.author, client: a.client}));
	const reopened = await h.owner.open(filename, a.client);
	await reopened.open();
	assert.equal((await reopened.scan()).length, 1);
	assert.equal((await fs.readdir(path.dirname(filename))).filter(name => name.startsWith('outbox-')).length, 0);
});

test('TLS trust and map credentials are enforced; revoked edit links cannot reconnect', async t =>
{
	const h = await fixture(t);
	await assert.rejects(serverRequest({...h.setup, ca: undefined}, '/v1/create', {xml}, h.setup.adminToken), /securely/);
	await assert.rejects(serverRequest(h.setup, '/v1/create', {xml}, 'wrong'), /Access denied/);
	const filename = await h.owner.create({xml, name: 'Office.drawio'});
	const a = await h.owner.open(filename, randomUUID());
	await a.open();
	const b = new ServerFolder(filename, parseInvite(await a.shareLink()), randomUUID());
	await b.open();
	await assert.rejects(b.rotateLink(), /owner/);
	await a.rotateLink();
	await assert.rejects(b.scan(), /revoked/);
	assert.deepEqual(await a.scan(), []);
	assert.notEqual(parseInvite(await a.shareLink()).token, b.connection.token);
	assert.throws(() => parseInvite(shareInvite({...a.connection, server: 'http://example.test'})), /HTTPS/);
});

test('server snapshots survive restart and old transport markers are replaced', async t =>
{
	const h = await fixture(t);
	const filename = await h.owner.create({xml: xml.replace('<mxfile>', '<mxfile sharemap-room="old" sharemap-heads="[]">'), name: 'Office.drawio'});
	const a = await h.owner.open(filename, randomUUID());
	await a.open();
	assert.doesNotMatch(a.manifest.base, /sharemap-room/);
	const op = await a.append({}, [], 'Alice', randomUUID());
	assert.equal(await a.snapshot(xml, []), false);
	assert.equal(await a.snapshot(xml, [op.id]), true);
	await h.restart();
	await a.open();
	const report = await a.diagnostics();
	assert.equal(report.edits.count, 1);
	assert.equal(report.transport, 'server');
	assert.equal(JSON.stringify(report).includes(xml), false);
	assert.equal(report.localPath, undefined);
});

test('incremental sync sends only new edits and refreshes safely across a server restart', async t =>
{
	const h = await fixture(t); const filename = await h.owner.create({xml, name: 'Any map.drawio'});
	const a = await h.owner.open(filename); await a.open();
	const b = await h.owner.open(filename); await b.open();
	assert.deepEqual(await b.updates(), []);
	await a.append({u: {one: {value: 'First'}}}, [], 'A', randomUUID());
	assert.equal((await b.updates()).length, 1);
	assert.deepEqual(await b.updates(), []);
	await h.restart();
	assert.equal((await b.updates()).length, 1);
	assert.deepEqual(await b.updates(), []);
});

test('unknown concurrent values are marked for review; different properties and causal changes merge normally', async t =>
{
	const h = await fixture(t); const filename = await h.owner.create({xml, name: 'Any map.drawio'});
	const a = await h.owner.open(filename); await a.open();
	const b = await h.owner.open(filename); await b.open();
	const first = await a.append({u: {page: {cells: {u: {desk: {value: 'A'}}}}}}, [], 'A', randomUUID());
	const separate = await b.append({u: {page: {cells: {u: {desk: {style: 'green'}}}}}}, [], 'B', randomUUID());
	assert.equal(separate.conflicts, undefined);
	const overlap = await b.append({u: {page: {cells: {u: {desk: {value: 'B'}}}}}}, [separate.id], 'B', randomUUID());
	assert.equal(overlap.conflicts[0].with, first.id);
	assert.deepEqual(overlap.conflicts[0].path, ['u', 'page', 'cells', 'u', 'desk', 'value']);
	const resolved = await a.append({u: {page: {cells: {u: {desk: {value: 'Chosen'}}}}}}, [first.id, overlap.id], 'A', randomUUID());
	assert.equal(resolved.conflicts, undefined);
});

test('a shared-map shortcut restores a missing cache; it does not create arbitrary ordinary files', async t =>
{
	const h = await fixture(t); const filename = await h.owner.create({xml, name: 'Any map.drawio'});
	const room = path.basename(path.dirname(filename));
	await fs.unlink(filename);
	assert.equal(await h.owner.restoreRoom(room), filename);
	await fs.unlink(filename); await h.owner.restorePath(filename);
	assert.match(await fs.readFile(filename, 'utf8'), /mxfile/);
	const unknown = path.join(h.directory, 'not-authorized.drawio'); await h.owner.restorePath(unknown);
	assert.equal(await fs.stat(unknown).then(() => true).catch(() => false), false);
	await assert.rejects(h.owner.restoreRoom('../escape'), /Invalid/);
});

test('presence reports active editing and deduplicates windows from one client without disk heartbeats', async t =>
{
	const h = await fixture(t); const filename = await h.owner.create({xml, name: 'Any map.drawio'});
	const client = randomUUID();
	const a = await h.owner.open(filename, client); await a.open();
	const b = await h.owner.open(filename, client); await b.open();
	await a.activity('Alex', 'page', ['desk'], true, 'desk');
	const peers = await b.activity('Alex', 'page', ['desk'], true, 'desk');
	assert.equal(peers.length, 1); assert.equal(peers[0].editing, true); assert.equal(peers[0].editingCell, 'desk');
	const serverRoom = path.join(h.directory, 'data', a.connection.room, 'map.drawio.collab');
	assert.equal((await fs.readdir(serverRoom)).some(name => name.startsWith('presence-')), false);
});

test('warm idle incremental polls do not reread files or return existing edits', async t =>
{
	const h = await fixture(t); const filename = await h.owner.create({xml, name: 'Any map.drawio'});
	const a = await h.owner.open(filename); await a.open();
	await a.append({u: {one: {value: 'First'}}}, [], 'A', randomUUID());
	await a.updates();
	let reads = 0;
	const original = fs.readFile;
	t.mock.method(fs, 'readFile', async (...args) => { reads++; return original(...args); });
	for (let index = 0; index < 5; index++) assert.deepEqual(await a.updates(), []);
	assert.equal(reads, 0);
});

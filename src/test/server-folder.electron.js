// Real desktop entry point, two independent editor replicas, and actual HTTPS.
import {app, BrowserWindow} from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createCollaborationServer} from '../server/server.js';
import {ServerMaps, ServerFolder} from '../main/server-folder.js';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'drawio-server-ui-'));
const userData = path.join(directory, 'profile');
app.commandLine.appendSwitch('user-data-dir', userData);
app.setPath('userData', userData);
const cert = await fs.readFile(new URL('./fixtures/sync-tls/cert.pem', import.meta.url));
const key = await fs.readFile(new URL('./fixtures/sync-tls/key.pem', import.meta.url));
const adminToken = randomUUID() + randomUUID();
const server = await createCollaborationServer({directory: path.join(directory, 'data'), cert, key, adminToken});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const setup = {server: 'https://127.0.0.1:' + server.address().port, ca: cert.toString(), adminToken};
const manager = new ServerMaps(userData, userData + '-maps');
await fs.mkdir(userData, {recursive: true});
await fs.writeFile(manager.setupPath, JSON.stringify(setup));
const xml = '<mxfile><diagram id="page" name="Test"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="desk" value="Desk" vertex="1" parent="1"><mxGeometry x="80" y="80" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>';
const filename = await manager.create({xml, name: 'Server test.drawio'});
const remoteFile = path.join(path.dirname(filename), 'Peer.drawio');
await fs.copyFile(filename, remoteFile);
const peerClient = randomUUID();
const originalOpen = ServerFolder.prototype.open;
ServerFolder.prototype.open = function(...args)
{
	if (this.filename === remoteFile) this.client = peerClient;
	return originalOpen.apply(this, args);
};
process.argv = [process.argv[0], process.argv[1], filename, remoteFile];
app.on('browser-window-created', (_event, win) => { win.hide(); });
async function until(fn, label, timeout = 25000)
{
	const end = Date.now() + timeout;
	let last;
	while (Date.now() < end)
	{
		try { const value = await fn(); if (value) return value; }
		catch (error) { last = error; }
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error('Timed out: ' + label + (last ? ' ' + last.message : ''));
}
async function attach(win)
{
	await until(() => win.webContents.executeJavaScript('typeof Draw !== "undefined" && typeof App !== "undefined"'), 'editor boot');
	await win.webContents.executeJavaScript('Draw.loadPlugin(ui => {window.testUi = ui;}); true');
	await until(() => win.webContents.executeJavaScript('!!window.testUi?.sharedFolder'), 'plugin');
	return code => win.webContents.executeJavaScript(code);
}
async function runTests()
{
const watchdog = setTimeout(() => app.exit(1), 110000);
let result = 1;
try
{
	await import('../main/electron.js');
	const first = await until(() => BrowserWindow.getAllWindows()[0], 'first window');
	const a = await attach(first);
	await until(() => a('!!testUi.sharedFolder.getSession()?.initialized'), 'first server session');
	await a('electron.sendMessage("newfile", {}); true');
	const second = await until(() => BrowserWindow.getAllWindows().find(win => win.id !== first.id), 'second window');
	const b = await attach(second);
	await b('testUi.loadArgs({args:[' + JSON.stringify(remoteFile) + ']}); true');
	await until(() => b('!!testUi.sharedFolder.getSession()?.initialized'), 'second server session');
	assert.equal(await a('testUi.sharedFolder.getSession().transport'), 'server');
	assert.equal(await a('testUi.sharedFolder.getSession().manifest.room'), await b('testUi.sharedFolder.getSession().manifest.room'));
	console.log('PASS: both real editors join one authoritative HTTPS server room');
	await Promise.all([
		a('testUi.editor.graph.model.setValue(testUi.editor.graph.model.getCell("desk"), "Letter changed"); true'),
		b('testUi.editor.graph.insertVertex(testUi.editor.graph.getDefaultParent(), "peer", "Peer desk", 300, 300, 100, 50); true')]);
	const merged = 'testUi.editor.graph.model.getCell("desk").value === "Letter changed" && !!testUi.editor.graph.model.getCell("peer")';
	await until(async () => await a(merged) && await b(merged), 'server shape convergence');
	assert.equal(first.webContents.getBackgroundThrottling(), false);
	assert.equal(second.webContents.getBackgroundThrottling(), false);
	console.log('PASS: label change and concurrent insert reach the other editor while hidden');
	const lost = ServerFolder.prototype.append;
	let loseOnce = true;
	ServerFolder.prototype.append = async function(...args)
	{
		const op = await lost.apply(this, args);
		if (this.filename === filename && loseOnce) { loseOnce = false; throw new Error('Simulated lost acknowledgement'); }
		return op;
	};
	try
	{
		await a('testUi.editor.graph.model.setValue(testUi.editor.graph.model.getCell("desk"), "Retry letter"); true');
		await until(() => !loseOnce, 'lost acknowledgement');
		await a('testUi.editor.graph.model.setValue(testUi.editor.graph.model.getCell("desk"), "Latest letter"); true');
		await until(async () => await a('testUi.editor.graph.model.getCell("desk").value === "Latest letter"') && await b('testUi.editor.graph.model.getCell("desk").value === "Latest letter"'), 'idempotent retry with newer typing');
	}
	finally { ServerFolder.prototype.append = lost; }
	const folder = await manager.open(filename, randomUUID());
	await folder.open();
	const records = await folder.scan();
	assert.equal(records.filter(op => JSON.stringify(op.patch).includes('Retry letter')).length, 1);
	console.log('PASS: lost acknowledgement retries once and preserves newer typing');
	await a('testUi.getCurrentFile().setModified(false); testUi.loadArgs({args:[' + JSON.stringify(filename) + ']}); true');
	await until(() => a('testUi.sharedFolder.getSession()?.initialized && testUi.editor.graph.model.getCell("desk").value === "Latest letter"'), 'reopen server state');
	const raw = await fs.readFile(filename, 'utf8');
	assert.equal(raw.includes('Latest letter'), false);
	assert.equal(await fs.stat(filename + '.collab').then(() => true).catch(() => false), false);
	console.log('PASS: reopening restores server edits without a OneDrive journal or local map writes');
	await until(async () => (await folder.diagnostics()).presence.filter(peer => peer.ageSeconds < 30).some(peer => peer.client === peerClient), 'peer heartbeat');
	console.log('PASS: server presence includes the separate peer installation');
	assert.equal(await a('document.body.innerText.includes("Saved to server")'), true);
	console.log('PASS: desktop header reports Saved to server');
	result = 0;
}
catch (error) { console.error(error.stack); }
finally
{
	clearTimeout(watchdog);
	for (const win of BrowserWindow.getAllWindows()) win.destroy();
	server.closeAllConnections();
	await new Promise(resolve => server.close(resolve));
	await fs.rm(directory, {recursive: true, force: true}).catch(() => {});
	app.exit(result);
}
}
runTests();

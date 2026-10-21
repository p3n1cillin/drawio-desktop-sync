// Runs against the actual production Electron entry point and bundled editor.
// Invoke with npm run test:shared-ui. All data and settings are synthetic.
import {app, BrowserWindow} from 'electron';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {SharedFolder} from '../main/shared-folder.js';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sharemap-ui-'));
const filename = path.join(directory, 'test-map.drawio');
const remoteFile = path.join(directory, 'remote', 'test-map.drawio');
const probeA = path.join(directory, 'probe-a.drawio');
const probeB = path.join(directory, 'probe-b.drawio');
const copyFile = path.join(directory, 'copy.drawio');
const xml = '<mxfile><diagram id="page" name="Test map"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="desk" value="Desk" vertex="1" parent="1" style="rounded=1;fillColor=#dae8fc;strokeColor=#6c8ebf;"><mxGeometry x="80" y="80" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>';
await fs.writeFile(filename, xml);
await fs.mkdir(path.dirname(remoteFile));
await fs.writeFile(remoteFile, xml);
await fs.writeFile(copyFile, xml);
for (const file of [probeA, probeB])
{
	await fs.writeFile(file, xml);
	await new SharedFolder(file).open(xml);
}
app.commandLine.appendSwitch('user-data-dir', path.join(directory, 'profile'));
process.argv = [process.argv[0], process.argv[1], filename, remoteFile, probeA, probeB, copyFile];
app.on('browser-window-created', (_event, win) =>
{
	win.hide();
	win.webContents.on('preload-error', (_event, file, error) => console.error('PRELOAD', file, error));
	win.webContents.on('console-message', details => console.log('RENDERER', details.message));
});

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function until(fn, label, timeout = 25000)
{
	const end = Date.now() + timeout;
	let last;
	while (Date.now() < end)
	{
		try { const value = await fn(); if (value) return value; }
		catch (e) { last = e; }
		await delay(100);
	}
	throw new Error('Timed out: ' + label + (last ? ': ' + last.message : ''));
}
async function attach(win)
{
	await until(() => win.webContents.executeJavaScript('typeof Draw !== "undefined" && typeof Draw.loadPlugin === "function" && typeof App !== "undefined"'), 'editor boot');
	await win.webContents.executeJavaScript('Draw.loadPlugin(function(ui) { window.testUi = ui; }); true');
	await until(() => win.webContents.executeJavaScript('!!(window.testUi && testUi.sharedFolder)'), 'collaboration loaded');
	return code => win.webContents.executeJavaScript(code);
}

let result = 1;
let syncEnabled = true;
let mirrorTimer;
async function mirror()
{
	if (!syncEnabled) return;
	for (const [from, to] of [[filename, remoteFile], [remoteFile, filename]])
	{
		const names = await fs.readdir(from + '.collab');
		for (const name of names.filter(name => name.endsWith('.json')))
		{
			await fs.copyFile(path.join(from + '.collab', name), path.join(to + '.collab', name), constants.COPYFILE_EXCL)
				.catch(e => { if (e.code !== 'EEXIST') throw e; });
		}
	}
}
const watchdog = setTimeout(() => { console.error('UI TEST WATCHDOG'); app.exit(1); }, 115000);
async function runTests()
{
try
{
	await import('../main/electron.js');
	const first = await until(() => BrowserWindow.getAllWindows()[0], 'first window');
	const a = await attach(first);
	await until(() => a('!!(testUi.getCurrentFile() && testUi.getCurrentFile().fileObject)'), 'map open');
	await a('testUi.sharedFolder.open(true).then(() => true)');
	await until(() => a('!!(testUi.sharedFolder.getSession() && testUi.sharedFolder.getSession().initialized)'), 'first shared session');
	console.log('PASS: enable shared editing in the bundled production editor');
	await fs.cp(filename + '.collab', remoteFile + '.collab', {recursive: true});
	mirrorTimer = setInterval(() => mirror().catch(e => console.error('MIRROR', e.message)), 150);
	await a('electron.sendMessage("newfile", {}); true');
	const second = await until(() => BrowserWindow.getAllWindows().find(win => win.id !== first.id), 'second window');
	const b = await attach(second);
	await b('testUi.loadArgs({args:[' + JSON.stringify(remoteFile) + ']}); true');
	await until(() => b('!!(testUi.sharedFolder.getSession() && testUi.sharedFolder.getSession().initialized)'), 'second shared session');
	console.log('PASS: auto-join shared map in a second editor');
	await until(() => b('document.querySelectorAll("button").length > 0'), 'header controls');

	await Promise.all([
		a('testUi.editor.graph.insertVertex(testUi.editor.graph.getDefaultParent(), "alice", "Alice desk", 100, 240, 120, 60); true'),
		b('testUi.editor.graph.insertVertex(testUi.editor.graph.getDefaultParent(), "bob", "Bob desk", 300, 240, 120, 60); true')]);
	const both = '!!testUi.editor.graph.model.getCell("alice") && !!testUi.editor.graph.model.getCell("bob")';
	await until(async () => await a(both) && await b(both), 'concurrent shape convergence');
	console.log('PASS: concurrent independent inserts converge');

	await Promise.all([
		a('testUi.editor.graph.model.setValue(testUi.editor.graph.model.getCell("desk"), "Alice renamed"); true'),
		b('testUi.editor.graph.model.setStyle(testUi.editor.graph.model.getCell("desk"), "rounded=1;fillColor=#d5e8d4;"); true')]);
	const preserved = 'testUi.editor.graph.model.getCell("desk").value === "Alice renamed" && testUi.editor.graph.model.getCell("desk").style.includes("#d5e8d4")';
	await until(async () => await a(preserved) && await b(preserved), 'property merge');
	console.log('PASS: simultaneous label and style edits on one shape both survive');

	await Promise.all([
		a('testUi.editor.graph.model.setValue(testUi.editor.graph.model.getCell("desk"), "Alice latest"); true'),
		b('testUi.editor.graph.model.setValue(testUi.editor.graph.model.getCell("desk"), "Bob latest"); true')]);
	await until(async () =>
	{
		const value = await a('testUi.editor.graph.model.getCell("desk").value');
		return /latest$/.test(value) && value === await b('testUi.editor.graph.model.getCell("desk").value');
	}, 'same-property convergence');
	console.log('PASS: same-property conflicts converge deterministically');

	await a('testUi.editor.graph.model.setValue(testUi.editor.graph.model.getCell("alice"), "Undo this"); true');
	await until(() => b('testUi.editor.graph.model.getCell("alice").value === "Undo this"'), 'before undo');
	await a('testUi.editor.undoManager.undo(); true');
	await until(() => b('testUi.editor.graph.model.getCell("alice").value === "Alice desk"'), 'undo propagates');
	console.log('PASS: undo after remote patches propagates');

	syncEnabled = false;
	await delay(300);
	await a('testUi.editor.graph.insertVertex(testUi.editor.graph.getDefaultParent(), "offline-a", "Offline Alice", 100, 350, 120, 60); true');
	await b('testUi.editor.graph.insertVertex(testUi.editor.graph.getDefaultParent(), "offline-b", "Offline Bob", 300, 350, 120, 60); true');
	await a('testUi.sharedFolder.cycle().then(() => true)');
	await b('testUi.sharedFolder.cycle().then(() => true)');
	assert.equal(await a('!!testUi.editor.graph.model.getCell("offline-b")'), false);
	assert.equal(await b('!!testUi.editor.graph.model.getCell("offline-a")'), false);
	syncEnabled = true;
	const offlineBoth = '!!testUi.editor.graph.model.getCell("offline-a") && !!testUi.editor.graph.model.getCell("offline-b")';
	await until(async () => await a(offlineBoth) && await b(offlineBoth), 'offline edits merge after resync');
	console.log('PASS: separate replicas retain offline edits and converge after delayed delivery');
	// Pause AutoSave while typing, then use the regular Save command. A paused
	// document must never be reinitialized by the polling timer.
	await a('[...document.querySelectorAll("button")].find(b=>b.textContent === "AutoSave  On").click(); true');
	await a('testUi.editor.graph.model.setValue(testUi.editor.graph.model.getCell("offline-a"), "Manual save test"); true');
	await delay(1200);
	assert.equal(await a('testUi.editor.graph.model.getCell("offline-a").value'), 'Manual save test');
	await a('new Promise((resolve,reject)=>testUi.getCurrentFile().save(false,resolve,reject)).then(()=>true)');
	await until(() => b('testUi.editor.graph.model.getCell("offline-a").value === "Manual save test"'), 'manual save while paused');
	await a('[...document.querySelectorAll("button")].find(b=>b.textContent === "AutoSave  Off").click(); true');
	console.log('PASS: AutoSave toggle preserves unsaved changes and manual Save still syncs');
	const hasRemoteAvatar = '[...document.querySelectorAll("span")].some(s=>s.title.includes("recently active"))';
	await until(async () => await a(hasRemoteAvatar) && await b(hasRemoteAvatar), 'recent editor presence');
	console.log('PASS: recent editor avatars arrive across separate replicas');

	await a('new Promise((resolve,reject) => testUi.getCurrentFile().save(false, resolve, reject)).then(() => true)');
	await until(async () => (await fs.readFile(filename, 'utf8')).includes('sharemap-heads'), 'materialized snapshot');
	const final = await fs.readFile(filename, 'utf8');
	assert.match(final, /Alice desk/);
	assert.match(final, /Bob desk/);
	console.log('PASS: Ctrl+S path saves journal and a standard .drawio snapshot');

	await a('testUi.sharedFolder.dialog(); true');
	const screenshot = process.env.SHAREMAP_TEST_SCREENSHOT;
	if (screenshot)
	{
		first.showInactive();
		await delay(500);
		const shot = await first.webContents.capturePage();
		first.hide();
		await fs.writeFile(screenshot, shot.toPNG());
	}
	await a('testUi.hideDialog(); true');

	// Reopen from the saved snapshot and replay the immutable journal.
	await b('testUi.loadArgs({args:[' + JSON.stringify(remoteFile) + ']}); true');
	await until(async () => await b('!!(testUi.sharedFolder.getSession() && testUi.sharedFolder.getSession().initialized)') && await b(both), 'reopen recovery');
	console.log('PASS: reopening restores all collaborators from the journal');

	// Deliberately delay filesystem operations while changing the document.
	// This exercises the production IPC bridge and actual fileLoaded events.
	const originalOpen = SharedFolder.prototype.open;
	let releaseOpen;
	let openEntered = false;
	SharedFolder.prototype.open = async function(...args)
	{
		if (this.filename === probeA)
		{
			openEntered = true;
			await new Promise(resolve => { releaseOpen = resolve; });
		}
		return originalOpen.apply(this, args);
	};
	try
	{
		await a('testUi.loadArgs({args:[' + JSON.stringify(probeA) + ']}); true');
		await until(() => openEntered, 'delayed document probe');
		await a('testUi.loadArgs({args:[' + JSON.stringify(probeB) + ']}); true');
		await until(() => a('testUi.getCurrentFile().fileObject.path === ' + JSON.stringify(probeB) + ' && testUi.getCurrentFile().shareMapGuard'), 'new document guarded during old probe');
		releaseOpen();
		await until(() => a('!!(testUi.sharedFolder.getSession()?.initialized && testUi.sharedFolder.getSession().path === ' + JSON.stringify(probeB) + ')'), 'new document joined after old probe');
		assert.equal(await a('testUi.editor.graph.isEnabled()'), true);
	}
	finally { SharedFolder.prototype.open = originalOpen; releaseOpen?.(); }
	console.log('PASS: rapid document switches join the new journal after delayed opening');

	const originalSnapshot = SharedFolder.prototype.snapshot;
	let releaseSnapshot;
	let snapshotEntered = false;
	SharedFolder.prototype.snapshot = async function(...args)
	{
		if (this.filename === probeB)
		{
			snapshotEntered = true;
			await new Promise(resolve => { releaseSnapshot = resolve; });
		}
		return originalSnapshot.apply(this, args);
	};
	try
	{
		await a('testUi.editor.graph.model.setValue(testUi.editor.graph.model.getCell("desk"), "Delayed save"); window.switchSave = new Promise(resolve => testUi.getCurrentFile().save(false, () => resolve("saved"), e => resolve(e.message))); true');
		await until(() => snapshotEntered, 'delayed snapshot');
		await a('testUi.getCurrentFile().setModified(false); testUi.loadArgs({args:[' + JSON.stringify(filename) + ']}); true');
		await until(() => a('testUi.getCurrentFile().fileObject.path === ' + JSON.stringify(filename)), 'switch during save');
		releaseSnapshot();
		assert.match(await a('window.switchSave'), /document changed/);
		await until(() => a('!!(testUi.sharedFolder.getSession()?.initialized && testUi.sharedFolder.getSession().path === ' + JSON.stringify(filename) + ')'), 'rejoin original journal');
		assert.equal(await a('testUi.editor.graph.model.getCell("desk").value === "Delayed save"'), false);
		assert.equal(await a('testUi.editor.graph.isEnabled()'), true);
	}
	finally { SharedFolder.prototype.snapshot = originalSnapshot; releaseSnapshot?.(); }
	console.log('PASS: delayed Save cannot modify another document after switching');
	// Use the path change made by the real Save As dialog, without opening an
	// interactive picker. The destination is an authorized synthetic file.
	await a('(()=>{const f=testUi.getCurrentFile(); f.fileObject={path:' + JSON.stringify(copyFile) + ',name:"copy.drawio",type:"utf-8"}; f.title="copy.drawio"; return new Promise((resolve,reject)=>f.save(false,resolve,reject,null,true));})().then(()=>true)');
	await until(() => a('!testUi.sharedFolder.getSession() && testUi.editor.graph.isEnabled()'), 'standalone copy saved');
	const copy = await fs.readFile(copyFile, 'utf8');
	assert.doesNotMatch(copy, /sharemap-room=/);
	assert.equal(await a(both), true);
	await a('testUi.sharedFolder.open(true).then(()=>true)');
	assert.notEqual((JSON.parse(await fs.readFile(copyFile + '.collab/manifest.json', 'utf8'))).room,
		(JSON.parse(await fs.readFile(filename + '.collab/manifest.json', 'utf8'))).room);
	console.log('PASS: Save As preserves all shapes and creates an independent journal');
	if (process.env.SHAREMAP_TEST_FIXTURE)
	{
		const realXml = await fs.readFile(process.env.SHAREMAP_TEST_FIXTURE, 'utf8');
		const summary = await a('(()=>{const p=testUi.getPagesForXml(' + JSON.stringify(realXml) + '); const saved=testUi.getXmlForPages(p); const restored=testUi.getPagesForXml(saved); return {pages:p.length,restoredPages:restored.length,nonempty:p.every(x=>!!x.root)};})()');
		assert.equal(summary.pages, summary.restoredPages);
		assert.equal(summary.nonempty, true);
		console.log('PASS: supplied map parses and round-trips all ' + summary.pages + ' pages without touching the original');
	}
	result = 0;
}
catch (e)
{
	console.error(e.stack);
	for (const win of BrowserWindow.getAllWindows())
	{
		try
		{
			console.error(await win.webContents.executeJavaScript('JSON.stringify({title:document.title,body:document.body.innerText.slice(-1500),session:window.testUi && testUi.sharedFolder && (()=>{const s=testUi.sharedFolder.getSession();return s && {initialized:s.initialized,error:s.error && s.error.message,records:s.records.size}})()})'));
		}
		catch {}
	}
}
finally
{
	clearTimeout(watchdog);
	clearInterval(mirrorTimer);
	for (const win of BrowserWindow.getAllWindows()) win.destroy();
	await fs.rm(directory, {recursive: true, force: true}).catch(() => {});
	app.exit(result);
}
}
runTests();

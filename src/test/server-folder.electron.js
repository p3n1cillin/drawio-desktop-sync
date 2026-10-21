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
// Keep teardown asynchronous without hiding failures behind window-all-closed.
app.on('will-quit', event => event.preventDefault());
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
const roomId = path.basename(path.dirname(filename));
const remoteFile = path.join(path.dirname(filename), 'Peer.drawio');
await fs.copyFile(filename, remoteFile);
const copyFile = path.join(directory, 'Standalone copy.drawio');
await fs.writeFile(copyFile, xml);
await fs.unlink(filename);
const peerClient = randomUUID();
const originalOpen = ServerFolder.prototype.open;
ServerFolder.prototype.open = function(...args)
{
	if (this.filename === remoteFile) this.client = peerClient;
	return originalOpen.apply(this, args);
};
process.argv = [process.argv[0], process.argv[1], '--shared-map=' + roomId, remoteFile, copyFile];
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
const watchdog = setTimeout(() => app.exit(1), 170000);
let result = 1;
try
{
	await import('../main/electron.js');
	const first = await until(() => BrowserWindow.getAllWindows()[0], 'first window');
	const a = await attach(first);
	await until(() => a('!!testUi.sharedFolder.getSession()?.initialized'), 'first server session');
	assert.equal(await fs.stat(filename).then(() => true), true);
	console.log('PASS: room-based shortcut restores a deleted launch cache before the file loader runs');
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
	const previousSession = await a('testUi.sharedFolder.getSession().id');
	await a('testUi.getCurrentFile().setModified(false); testUi.loadArgs({args:[' + JSON.stringify(filename) + ']}); true');
	await until(() => a('testUi.sharedFolder.getSession()?.initialized && testUi.sharedFolder.getSession().id !== ' + JSON.stringify(previousSession) + ' && testUi.editor.graph.model.getCell("desk").value === "Latest letter"'), 'reopen server state');
	const raw = await fs.readFile(filename, 'utf8');
	assert.equal(raw.includes('Latest letter'), false);
	assert.equal(await fs.stat(filename + '.collab').then(() => true).catch(() => false), false);
	console.log('PASS: reopening restores server edits without a OneDrive journal or local map writes');
	await until(async () => (await folder.diagnostics()).presence.filter(peer => peer.ageSeconds < 30).some(peer => peer.client === peerClient), 'peer heartbeat');
	console.log('PASS: server presence includes the separate peer installation');
	assert.equal(await a('document.body.innerText.includes("Saved to server")'), true);
	console.log('PASS: desktop header reports Saved to server');
	await a('testUi.sharedFolder.cycle().then(()=>true)');
	const idle = await a('(async()=>{let clones=0,serializations=0;const clone=testUi.clonePages,serialize=testUi.getNodeForPages;testUi.clonePages=function(){clones++;return clone.apply(this,arguments)};testUi.getNodeForPages=function(){serializations++;return serialize.apply(this,arguments)};try{for(let i=0;i<5;i++)await testUi.sharedFolder.cycle();return {clones,serializations}}finally{testUi.clonePages=clone;testUi.getNodeForPages=serialize}})()');
	assert.deepEqual(idle, {clones: 0, serializations: 0});
	console.log('PASS: five idle sync cycles do not clone pages or serialize the diagram');
	await a('localStorage.removeItem(".sharemapName");testUi.sharedFolder.getSession().name="Alice";testUi.sharedFolder.getSession().lastActivity=0;testUi.editor.graph.setSelectionCell(testUi.editor.graph.model.getCell("desk"));testUi.editor.graph.startEditingAtCell(testUi.editor.graph.model.getCell("desk"));true');
	await b('testUi.sharedFolder.getSession().name="Bob";testUi.sharedFolder.getSession().lastActivity=0;testUi.editor.graph.setSelectionCell(testUi.editor.graph.model.getCell("desk"));true');
	await until(() => b('document.querySelector(".geSyncEditingNote")?.textContent.includes("Alice is editing")'), 'editing indicator');
	assert.equal(await b('[...document.querySelectorAll(".geSyncPresenceLabel")].some(node=>node.textContent.includes("Alice")&&node.textContent.includes("editing"))'), true);
	if (process.env.DRAWIO_UI_SCREENSHOT) await fs.writeFile(process.env.DRAWIO_UI_SCREENSHOT, (await second.webContents.capturePage()).toPNG());
	await a('testUi.editor.graph.stopEditing(true);true');
	console.log('PASS: a held label edit shows the editor name on the object and warns the other editor');
	await Promise.all([a('testUi.sharedFolder.cycle().then(()=>true)'), b('testUi.sharedFolder.cycle().then(()=>true)')]);
	const pause = '[...document.querySelectorAll("button")].find(button=>button.textContent.startsWith("AutoSave")).click();true';
	await Promise.all([a(pause), b(pause)]);
	await Promise.all([a('testUi.editor.graph.model.setValue(testUi.editor.graph.model.getCell("desk"),"Alice overlap");true'), b('testUi.editor.graph.model.setValue(testUi.editor.graph.model.getCell("desk"),"Bob overlap");true')]);
	await Promise.all([a('testUi.sharedFolder.cycle().then(()=>true)'), b('testUi.sharedFolder.cycle().then(()=>true)')]);
	await Promise.all([a(pause), b(pause)]);
	await until(async () => await a('!!testUi.sharedFolder.getSession().conflicts?.size') && await b('!!testUi.sharedFolder.getSession().conflicts?.size'), 'overlap review on both clients');
	await a('(()=>{const s=testUi.sharedFolder.getSession();const key=[...s.conflicts.keys()].at(-1);return testUi.sharedFolder.resolveConflict(key,true)})().then(()=>true)');
	await until(async () => await a('testUi.editor.graph.model.getCell("desk").value') === await b('testUi.editor.graph.model.getCell("desk").value'), 'restored overlapping value');
	console.log('PASS: concurrent text edits create reviewable conflicts and restoring an earlier value reaches both editors');
	await a(pause);
	const before = await b('testUi.editor.graph.model.getCell("desk").value');
	await a('testUi.editor.graph.model.setValue(testUi.editor.graph.model.getCell("desk"),"Manual save while paused");true');
	await new Promise(resolve => setTimeout(resolve, 1300));
	assert.equal(await b('testUi.editor.graph.model.getCell("desk").value'), before);
	await a('new Promise((resolve,reject)=>testUi.getCurrentFile().save(false,resolve,reject)).then(()=>true)');
	await until(() => b('testUi.editor.graph.model.getCell("desk").value === "Manual save while paused"'), 'manual save with AutoSave off');
	const pausedSession = await a('testUi.sharedFolder.getSession().id');
	await a('testUi.loadArgs({args:[' + JSON.stringify(filename) + ']});true');
	await until(() => a('testUi.sharedFolder.getSession()?.initialized && testUi.sharedFolder.getSession().id !== ' + JSON.stringify(pausedSession)), 'reopened paused map');
	assert.equal(await a('testUi.sharedFolder.getSession().paused'), true);
	console.log('PASS: the shared-map AutoSave preference survives reopening the map');
	await a(pause);
	console.log('PASS: AutoSave off preserves local changes and Ctrl+S still publishes');
	await a('testUi.editor.graph.model.setValue(testUi.editor.graph.model.getCell("peer"),"Undo this");true');
	await until(() => b('testUi.editor.graph.model.getCell("peer").value === "Undo this"'), 'before undo');
	await a('testUi.editor.undoManager.undo();true');
	await until(() => b('testUi.editor.graph.model.getCell("peer").value === "Peer desk"'), 'server undo');
	console.log('PASS: undo after incoming server patches propagates');
	await a('(()=>{const file=testUi.getCurrentFile();file.fileObject={path:' + JSON.stringify(copyFile) + ',name:"Standalone copy.drawio",type:"utf-8"};file.title="Standalone copy.drawio";return new Promise((resolve,reject)=>file.save(false,resolve,reject,null,true))})().then(()=>true)');
	await until(() => a('!testUi.sharedFolder.getSession() && testUi.editor.graph.isEnabled()'), 'ordinary Save As');
	assert.doesNotMatch(await fs.readFile(copyFile, 'utf8'), /sharemap-room=/);
	console.log('PASS: Save As produces an independent ordinary diagram and leaves server mode');
	await a(`(() => {
		window.configurationMarker = {};
		window.configurationModelChanges = 0;
		testUi.editor.graph.model.addListener(mxEvent.CHANGE, () => window.configurationModelChanges++);
		testUi.actions.get('configuration').funct();
		const root = document.querySelector('.geDialog');
		const tab = [...root.querySelectorAll('div')].find(node => node.textContent === mxResources.get('formatJson') && node.style.cursor === 'pointer');
		if (!tab) throw Error('JSON tab was not found');
		tab.click();
		const input = [...root.querySelectorAll('textarea')].find(node => node.offsetParent !== null);
		input.value = JSON.stringify({...JSON.parse(localStorage.getItem(Editor.configurationKey) || '{}'),
			enablePositionGuides:false,enableDistanceGuides:false,enableSizeGuides:false,
			defaultConnectable:false,defaultConnectionArrowsEnabled:false,copyOnConnect:true,
			defaultFoldingEnabled:false,defaultTransparentGroups:true,zoomWheel:false,
			defaultGridSize:17,gridSteps:7,compact:true,updateDefaultStyle:true,simpleLabels:true});
		input.dispatchEvent(new Event('input', {bubbles:true}));
		[...root.querySelectorAll('button')].find(button => button.textContent === mxResources.get('apply')).click();
		return true;
	})()`);
	const liveOptions = `!!testUi.livePreferences && mxGuide.prototype.positionEnabled === false &&
		mxGuide.prototype.distanceEnabled === false && mxVertexHandler.prototype.sizeGuidesEnabled === false &&
		!testUi.editor.graph.connectionHandler.isEnabled() && !testUi.editor.graph.connectionArrowsEnabled &&
		testUi.editor.graph.connectionHandler.createTarget && !testUi.editor.graph.foldingEnabled &&
		Editor.defaultTransparentGroups && !Graph.zoomWheel && testUi.editor.graph.gridSize === 17 &&
		testUi.editor.graph.view.gridSteps === 7 && testUi.compactMode && testUi.updateDefaultStyle && Editor.simpleLabels`;
	await until(() => a(liveOptions), 'live visual/JSON configuration');
	assert.equal(await a('!!window.configurationMarker && window.configurationModelChanges === 0 && !testUi.dialog'), true, 'Apply does not reload, edit the model or ask for a restart');
	await until(() => b(liveOptions), 'configuration reaches another open editor');
	const preferences = JSON.parse(await fs.readFile(path.join(userData, 'editor-preferences.json'), 'utf8'));
	assert.equal(JSON.parse(preferences.entries['.configuration']).enablePositionGuides, false);
	console.log('PASS: the actual Configuration dialog applies guides, connections, folding, wheel zoom, compact UI and grid live across open editors without diagram changes');
	await a(`(() => {
		testUi.actions.get('configuration').funct();
		const root = document.querySelector('.geDialog');
		const toggle = root.querySelector('[data-key="enablePositionGuides"]');
		if (!toggle) throw Error('Visual guide control was not found');
		const on = [...toggle.querySelectorAll('button')].find(button => button.dataset.value === 'true');
		if (!on) throw Error('Visual On button was not found');
		on.click();
		toggle.scrollIntoView({block:'center'});
		return true;
	})()`);
	if (process.env.DRAWIO_SETTINGS_SCREENSHOT)
	{
		const throttled = first.webContents.getBackgroundThrottling();
		first.webContents.setBackgroundThrottling(false);
		await new Promise(resolve => setTimeout(resolve, 250));
		await fs.writeFile(process.env.DRAWIO_SETTINGS_SCREENSHOT, (await first.webContents.capturePage()).toPNG());
		first.webContents.setBackgroundThrottling(throttled);
	}
	await a('[...document.querySelector(".geDialog").querySelectorAll("button")].find(button=>button.textContent===mxResources.get("apply")).click();true');
	await until(() => a('mxGuide.prototype.positionEnabled === true && !testUi.dialog'), 'visual Editor toggle applies live');
	console.log('PASS: the visual Editor tab applies its On/Off controls without a restart prompt');
	const priorSpellCheck = first.webContents.session.isSpellCheckerEnabled();
	await a('testUi.actions.get("spellCheck").funct();true');
	await until(() => first.webContents.session.isSpellCheckerEnabled() !== priorSpellCheck, 'live spell checker');
	assert.equal(await a('testUi.actions.get("spellCheck").isSelected()'), !priorSpellCheck);
	await until(async () => await b('testUi.actions.get("spellCheck").isSelected()') === !priorSpellCheck, 'other editor spell checker menu');
	assert.equal(await a('!testUi.dialog'), true);
	console.log('PASS: spell checking and its menu state change live in existing editor windows');
	const beforeInvalid = await a('localStorage.getItem(Editor.configurationKey)');
	assert.equal(await a('(()=>{try{localStorage.setItem(Editor.configurationKey,"[]");return false}catch{return true}})()'), true);
	assert.equal(await a('localStorage.getItem(Editor.configurationKey)'), beforeInvalid);
	console.log('PASS: invalid configuration cannot replace the last saved valid settings');
	const originalTemplate = await a('Editor.config.templateFile || null');
	await a(`(() => {
		testUi.actions.get('configuration').funct();
		const root = document.querySelector('.geDialog');
		[...root.querySelectorAll('div')].find(node => node.textContent === mxResources.get('formatJson') && node.style.cursor === 'pointer').click();
		const input = [...root.querySelectorAll('textarea')].find(node => node.offsetParent !== null);
		input.value = JSON.stringify({...JSON.parse(input.value),templateFile:'file:///not-authorized-by-a-runtime-setting.json'});
		input.dispatchEvent(new Event('input',{bubbles:true}));
		[...root.querySelectorAll('button')].find(button => button.textContent === mxResources.get('apply')).click();
		return true;
	})()`);
	assert.equal(await a('document.querySelector(".geDialog")?.innerText.includes("new editor window")'), true);
	assert.equal(await a('Editor.config.templateFile || null'), originalTemplate);
	await a('testUi.hideDialog();localStorage.setItem(Editor.configurationKey,' + JSON.stringify(beforeInvalid) + ');true');
	console.log('PASS: startup-only file configuration is saved with a clear notice and does not widen current file access');
	await first.webContents.session.clearStorageData({storages: ['localstorage']});
	await a('electron.sendMessage("newfile", {});true');
	const third = await until(() => BrowserWindow.getAllWindows().find(win => win.id !== first.id && win.id !== second.id), 'fresh editor after storage loss');
	const c = await attach(third);
	await until(() => c('!!testUi.livePreferences'), 'preferences restored before boot');
	assert.equal(await c('JSON.parse(localStorage.getItem(Editor.configurationKey)).defaultGridSize'), 17);
	assert.equal(await c('mxGuide.prototype.positionEnabled === true && mxGuide.prototype.distanceEnabled === false && Graph.zoomWheel === false'), true);
	console.log('PASS: configuration and user preferences restore before editor boot after Chromium storage is cleared');
	await c('localStorage.removeItem(Editor.configurationKey);true');
	assert.equal(JSON.parse(await fs.readFile(path.join(userData, 'editor-preferences.json'), 'utf8')).entries['.configuration'], null);
	console.log('PASS: resetting Configuration is durable and cannot restore an older saved configuration');
	result = 0;
}
catch (error)
{
	console.error(error.stack);
	for (const win of BrowserWindow.getAllWindows())
	{
		try { console.error(await win.webContents.executeJavaScript('JSON.stringify({editing:testUi.editor.graph.isEditing(),editingCell:testUi.editor.graph.cellEditor?.editingCell?.id,peers:testUi.sharedFolder.getSession()?.lastPeers,note:document.querySelector(".geSyncEditingNote")?.textContent,error:testUi.sharedFolder.getSession()?.error?.message})')); } catch {}
		try { console.error(await win.webContents.executeJavaScript('JSON.stringify({configuration:localStorage.getItem(Editor.configurationKey),live:testUi.livePreferences?.getResult(),position:mxGuide.prototype.positionEnabled,distance:mxGuide.prototype.distanceEnabled,size:mxVertexHandler.prototype.sizeGuidesEnabled,connectable:testUi.editor.graph.connectionHandler.isEnabled(),arrows:testUi.editor.graph.connectionArrowsEnabled,copy:testUi.editor.graph.connectionHandler.createTarget,folding:testUi.editor.graph.foldingEnabled,transparent:Editor.defaultTransparentGroups,wheel:Graph.zoomWheel,grid:testUi.editor.graph.gridSize,steps:testUi.editor.graph.view.gridSteps,compact:testUi.compactMode,style:testUi.updateDefaultStyle,simple:Editor.simpleLabels,dialog:document.querySelector(".geDialog")?.innerText})')); } catch {}
	}
}
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

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {registerSharedFolder} from '../main/shared-folder-ipc.js';

async function fixture(t, syncLocation = async () => ({folderUrl: 'https://company.sharepoint.com/sites/IT/'}))
{
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sharemap-ipc-'));
	t.after(() => fs.rm(directory, {recursive: true, force: true}));
	const filename = path.join(directory, 'map.drawio');
	await fs.writeFile(filename, '<mxfile/>');
	let handler;
	let copied;
	const sender = new EventEmitter();
	sender.mainFrame = {};
	sender.isDestroyed = () => false;
	const event = {sender, senderFrame: sender.mainFrame};
	registerSharedFolder({ipcMain: {handle: (_channel, callback) => { handler = callback; }},
		validateSender: frame => frame === sender.mainFrame, assertWritablePath: async () => {},
		clipboard: {writeText: value => { copied = value; }}, shell: {}, syncLocation});
	return {filename, event, sender, copied: () => copied, call: request => handler(event, request)};
}

test('Copy link uses the explicit sharing link before a registry folder URL', async t =>
{
	const h = await fixture(t);
	const info = await h.call({action: 'open', path: h.filename, base: '<mxfile/>'});
	await h.call({action: 'copyLink', id: info.id});
	assert.equal(h.copied(), 'https://company.sharepoint.com/sites/IT/');
	const url = 'https://company.sharepoint.com/:f:/s/IT/sharing-token';
	await h.call({action: 'link', id: info.id, url});
	assert.equal(await h.call({action: 'link', id: info.id}), url);
	await h.call({action: 'copyLink', id: info.id});
	assert.equal(h.copied(), url);
});

test('leaving a missing collaboration folder closes the session successfully', async t =>
{
	const h = await fixture(t);
	const info = await h.call({action: 'open', path: h.filename, base: '<mxfile/>'});
	await fs.rm(h.filename + '.collab', {recursive: true});
	assert.equal(await h.call({action: 'close', id: info.id}), true);
	await assert.rejects(h.call({action: 'scan', id: info.id}), /closed/);
});

test('an editor destroyed during opening cannot acquire an orphaned session', async t =>
{
	const h = await fixture(t, async () => { h.sender.isDestroyed = () => true; h.sender.emit('destroyed'); return null; });
	await assert.rejects(h.call({action: 'open', path: h.filename, base: '<mxfile/>'}), /Editor was closed/);
});

test('shared folder requests from a subframe are rejected', async t =>
{
	const h = await fixture(t);
	h.event.senderFrame = {};
	await assert.rejects(h.call({action: 'open', path: h.filename, base: '<mxfile/>'}), /denied/);
});

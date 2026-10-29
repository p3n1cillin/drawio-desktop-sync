import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {userInfo} from 'node:os';

export function registerSharedFolder({ipcMain, validateSender, assertWritablePath, clipboard,
	clientId, serverMaps, clientBuild = 'unknown', confirmServer = async () => false, blessServerMap = () => {}, createShortcut = () => null,
	identity = async () => ({name: userInfo().username, email: ''})})
{
	let me = null;
	const whoami = () => (me = me || identity().catch(() => ({name: userInfo().username, email: ''})));
	const owners = new Map();
	const initialThrottling = new WeakMap();
	ipcMain.handle('shared-folder', async (event, request) =>
	{
		if (!validateSender(event.senderFrame) || event.senderFrame !== event.sender.mainFrame) throw new Error('Shared map access denied');
		if (!request || typeof request !== 'object') throw new Error('Invalid request');
		if (request.action === 'serverJoin' || request.action === 'serverCreate')
		{
			if (!serverMaps) throw new Error('Server collaboration is unavailable');
			if (request.action === 'serverCreate') await assertWritablePath(request.path);
			if (!await confirmServer(request)) throw new Error('Server connection was cancelled');
			const filename = request.action === 'serverJoin' ? await serverMaps.join(request.invite, clientId) :
				await serverMaps.create({xml: request.xml, name: path.basename(request.path)}, clientId);
			blessServerMap(filename);
			let shortcut = null;
			try { shortcut = createShortcut(await serverMaps.open(filename, clientId)); }
			catch { /* Joining succeeds even when the desktop folder is unavailable. */ }
			return {path: filename, shortcutCreated: !!shortcut};
		}
		let sessions = owners.get(event.sender);
		if (!sessions)
		{
			sessions = new Map();
			owners.set(event.sender, sessions);
			event.sender.once('destroyed', () =>
			{
				for (const folder of sessions.values()) folder.leave().catch(() => {});
				owners.delete(event.sender);
			});
		}
		if (request.action === 'open')
		{
			if (typeof request.path !== 'string' || !/\.drawio$/i.test(request.path)) throw new Error('Open a .drawio map first');
			await assertWritablePath(request.path);
			const folder = await serverMaps?.open(request.path, clientId);
			if (!folder) return null;
			const info = await folder.open();
			if (event.sender.isDestroyed()) throw new Error('Editor was closed while opening the shared map');
			if (sessions.size === 0) initialThrottling.set(event.sender, event.sender.getBackgroundThrottling());
			event.sender.setBackgroundThrottling(false);
			const id = randomUUID();
			sessions.set(id, folder);
			const user = await whoami();
			return {id, ...info, mapName: info.name, name: user.name, email: user.email};
		}
		const folder = sessions.get(request.id);
		if (!folder) throw new Error('Shared session is closed');
		if (request.action === 'close')
		{
			sessions.delete(request.id);
			if (sessions.size === 0 && !event.sender.isDestroyed())
			{
				event.sender.setBackgroundThrottling(initialThrottling.get(event.sender) ?? true);
				initialThrottling.delete(event.sender);
			}
			await folder.leave().catch(() => {});
			return true;
		}
		await assertWritablePath(folder.filename);
		const user = await whoami();
		switch (request.action)
		{
			case 'scan': return {records: await folder.updates(), peers: folder.peers || []};
			case 'activity': return folder.activity(request.name || user.name, request.page, request.selection, request.editing, request.editingCell, request.pointer, user.email);
			case 'append': return folder.append(request.patch, request.parents, request.name || user.name, request.operationId, user.email);
			case 'launchState': return folder.launchState();
			case 'saveLaunchState': return folder.saveLaunchState({count: request.count, last: request.last, xml: request.xml});
			case 'watch': return folder.watch({cursor: request.cursor, epoch: request.epoch, comments: request.comments, presence: request.presence});
			case 'comments': return folder.comments();
			case 'people': return folder.people();
			case 'comment': return folder.comment({op: request.op, content: request.content, anchor: request.anchor, parent: request.parent,
				comment: request.comment, resolve: !!request.resolve, reopen: !!request.reopen, name: request.name || user.name, email: user.email});
			case 'snapshot': return folder.snapshot(request.xml, request.heads);
			case 'history':
			{
				const {created, times} = await folder.history();
				return {created, times};
			}
			case 'copyLink': clipboard.writeText(await folder.shareLink(request.kind === 'view' ? 'view' : 'edit')); return true;
			case 'shortcut': return createShortcut(folder);
			case 'rotateLink':
				if (!await confirmServer({action: 'rotateLink', server: folder.connection.server})) throw new Error('Link revocation was cancelled');
				return folder.rotateLink(request.kind === 'view' ? 'view' : 'edit');
			case 'diagnostics':
			{
				const report = await folder.diagnostics();
				report.clientBuild = clientBuild;
				report.server = folder.connection.server;
				report.connection = folder.stats;
				report.backgroundThrottling = event.sender.getBackgroundThrottling();
				if (request.editor && typeof request.editor === 'object')
				{
					report.editor = {initialized: !!request.editor.initialized, paused: !!request.editor.paused,
						running: !!request.editor.running, editing: !!request.editor.editing, mouseDown: !!request.editor.mouseDown,
						error: String(request.editor.error || '').slice(0, 1000), presenceError: String(request.editor.presenceError || '').slice(0, 1000)};
				}
				if (request.copy) clipboard.writeText(JSON.stringify(report, null, 2));
				return report;
			}
			default: throw new Error('Unknown collaboration action');
		}
	});
}

export async function sharedFolderScript(baseDirectory)
{
	return (await fs.readFile(path.join(baseDirectory, '../shared/preference-keys.cjs'), 'utf8')) + '\n' +
		(await fs.readFile(path.join(baseDirectory, '../renderer/preferences.js'), 'utf8')) + '\n' +
		(await fs.readFile(path.join(baseDirectory, '../shared/journal-core.cjs'), 'utf8')) + '\n' +
		(await fs.readFile(path.join(baseDirectory, '../shared/conflicts.cjs'), 'utf8')) + '\n' +
		(await fs.readFile(path.join(baseDirectory, '../shared/version-history.cjs'), 'utf8')) + '\n' +
		(await fs.readFile(path.join(baseDirectory, '../shared/change-log.cjs'), 'utf8')) + '\n' +
		(await fs.readFile(path.join(baseDirectory, '../renderer/shared-folder.js'), 'utf8')) + '\n' +
		(await fs.readFile(path.join(baseDirectory, '../renderer/collaboration-panels.js'), 'utf8'));
}

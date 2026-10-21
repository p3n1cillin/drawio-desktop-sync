import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {userInfo} from 'node:os';
import {SharedFolder} from './shared-folder.js';
import {getSyncLocation, showOneDriveShare, getSharedCloudStatus} from './onedrive-shell.js';

export function registerSharedFolder({ipcMain, validateSender, assertWritablePath, clipboard, shell,
	syncLocation = getSyncLocation, nativeShare = showOneDriveShare, cloudStatus = getSharedCloudStatus, clientId,
	serverMaps, confirmServer = async () => false, blessServerMap = () => {}})
{
	const owners = new Map();
	const initialThrottling = new WeakMap();
	ipcMain.handle('shared-folder', async (event, request) =>
	{
		if (!validateSender(event.senderFrame) || event.senderFrame !== event.sender.mainFrame)
		{
			throw new Error('Shared folder access denied');
		}
		if (!request || typeof request !== 'object') throw new Error('Invalid request');
		if (request.action === 'serverJoin' || request.action === 'serverCreate')
		{
			if (!serverMaps) throw new Error('Server collaboration is unavailable');
			if (request.action === 'serverCreate') await assertWritablePath(request.path);
			if (!await confirmServer(request)) throw new Error('Server connection was cancelled');
			const filename = request.action === 'serverJoin' ? await serverMaps.join(request.invite, clientId) :
				await serverMaps.create({xml: request.xml, name: path.basename(request.path)}, clientId);
			blessServerMap(filename);
			return {path: filename};
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
			if (typeof request.path !== 'string' || !/\.drawio$/i.test(request.path))
			{
				throw new Error('Save the map as a .drawio file first');
			}
			await assertWritablePath(request.path);
			const remote = await serverMaps?.open(request.path, clientId);
			const folder = remote || new SharedFolder(request.path, clientId);
			const cloud = remote ? null : await syncLocation(request.path);
			let info = await folder.open(request.base);
			if (!info && cloud && typeof request.seed === 'string')
			{
				// A cloud file selected through OS chrome enables AutoSave like
				// Excel. The original bytes are retained in the journal folder.
				const original = await fs.readFile(request.path, 'utf8');
				if (/\bsharemap-room=/.test(original)) throw new Error('Wait for the matching .collab folder to download');
				info = await folder.open(request.seed);
				await folder.immutable('original.json', {xml: original}).catch(e => { if (e.code !== 'EEXIST') throw e; });
			}
			if (!info) return null;
			if (event.sender.isDestroyed()) throw new Error('Editor was closed while opening the shared map');
			if (sessions.size === 0) initialThrottling.set(event.sender, event.sender.getBackgroundThrottling());
			// Collaboration must keep polling and publishing presence when the
			// editor is covered or minimized, including after long idle periods.
			event.sender.setBackgroundThrottling(false);
			const id = randomUUID();
			sessions.set(id, folder);
			folder.cloud = cloud;
			return {id, ...info, cloud, name: userInfo().username};
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
			// A missing/offline directory must not prevent leaving a document.
			await folder.leave().catch(() => {});
			return true;
		}
		await assertWritablePath(folder.filename);
		switch (request.action)
		{
			case 'scan': return folder.scan();
			case 'activity': return folder.activity(request.name || userInfo().username, request.page, request.selection);
			case 'append': return folder.append(request.patch, request.parents, request.name || userInfo().username, request.operationId);
			case 'snapshot': return folder.snapshot(request.xml, request.heads);
			case 'link': return request.url ? folder.shareLink(request.url) : (await folder.shareLink() || folder.cloud?.folderUrl || '');
			case 'copyLink':
			{
				const link = await folder.shareLink() || folder.cloud?.folderUrl;
				if (!link) throw new Error('Add the SharePoint folder link first');
				clipboard.writeText(link);
				return true;
			}
			case 'reveal': shell.showItemInFolder(folder.filename); return true;
			case 'rotateLink':
			{
				if (folder.transport !== 'server') throw new Error('Open a server map first');
				return folder.rotateLink();
			}
			case 'shareNative':
			case 'manageAccess':
			{
				if (folder.transport === 'server') { clipboard.writeText(await folder.shareLink()); return {server: true}; }
				try { await nativeShare(folder.filename, request.action === 'manageAccess' ? 'access' : 'share'); return {web: false}; }
				catch
				{
					const value = folder.cloud?.folderUrl || await folder.shareLink();
					let link;
					try { link = new URL(value); } catch {}
					if (!link || link.protocol !== 'https:' || link.username || link.password || !/^[a-z0-9-]+\.sharepoint\.com$/i.test(link.hostname))
					{
						throw new Error('Windows did not expose OneDrive sharing for this folder. Add its SharePoint folder link in Collaboration details, then retry.');
					}
					await shell.openExternal(link.href);
					return {web: true};
				}
			}
			case 'diagnostics':
			{
				if (folder.transport !== 'server') await folder.safePath('manifest.json');
				const report = await folder.diagnostics();
				report.clientBuild = '32.5.6';
				if (folder.transport === 'server') report.server = folder.connection.server;
				report.cloud = folder.cloud;
				report.backgroundThrottling = event.sender.getBackgroundThrottling();
				report.cloudFiles = folder.transport === 'server' ? {supported: false, transport: 'server'} : await cloudStatus(folder.filename).catch(() => ({supported: false, error: 'Windows could not inspect Cloud Files state. Check the OneDrive icon.'}));
				if (request.editor && typeof request.editor === 'object')
				{
					report.editor = {initialized: !!request.editor.initialized, paused: !!request.editor.paused,
						running: !!request.editor.running, editing: !!request.editor.editing, mouseDown: !!request.editor.mouseDown,
						error: String(request.editor.error || '').slice(0, 1000),
						presenceError: String(request.editor.presenceError || '').slice(0, 1000)};
				}
				if (request.copy) clipboard.writeText(JSON.stringify(report, null, 2));
				return report;
			}
			default: throw new Error('Unknown shared folder action');
		}
	});
}

export async function sharedFolderScript(baseDirectory)
{
	return (await fs.readFile(path.join(baseDirectory, '../shared/journal-core.cjs'), 'utf8')) + '\n' +
		(await fs.readFile(path.join(baseDirectory, '../renderer/shared-folder.js'), 'utf8'));
}

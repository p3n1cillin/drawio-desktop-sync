import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {userInfo} from 'node:os';
import {SharedFolder} from './shared-folder.js';
import {getSyncLocation, showOneDriveShare, getSharedCloudStatus} from './onedrive-shell.js';

export function registerSharedFolder({ipcMain, validateSender, assertWritablePath, clipboard, shell,
	syncLocation = getSyncLocation, nativeShare = showOneDriveShare, cloudStatus = getSharedCloudStatus, clientId})
{
	const owners = new Map();
	ipcMain.handle('shared-folder', async (event, request) =>
	{
		if (!validateSender(event.senderFrame) || event.senderFrame !== event.sender.mainFrame)
		{
			throw new Error('Shared folder access denied');
		}
		if (!request || typeof request !== 'object') throw new Error('Invalid request');
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
			const folder = new SharedFolder(request.path, clientId);
			const cloud = await syncLocation(request.path);
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
			// A missing/offline directory must not prevent leaving a document.
			await folder.leave().catch(() => {});
			return true;
		}
		await assertWritablePath(folder.filename);
		switch (request.action)
		{
			case 'scan': return folder.scan();
			case 'activity': return folder.activity(request.name || userInfo().username, request.page, request.selection);
			case 'append': return folder.append(request.patch, request.parents, request.name || userInfo().username);
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
			case 'shareNative':
			case 'manageAccess':
			{
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
				await folder.safePath('manifest.json');
				const report = await folder.diagnostics();
				report.cloud = folder.cloud;
				report.cloudFiles = await cloudStatus(folder.filename).catch(() => ({supported: false, error: 'Windows could not inspect Cloud Files state. Check the OneDrive icon.'}));
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

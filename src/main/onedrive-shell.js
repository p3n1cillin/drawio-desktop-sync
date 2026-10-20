import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {getSystem32Path} from './system-path.js';

const run = promisify(execFile);
let rootsPromise;
async function powershell(script, environment = {})
{
	const result = await run(getSystem32Path('WindowsPowerShell/v1.0/powershell.exe'),
		['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
		{windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, env: {...process.env, ...environment}});
	return result.stdout.trim();
}

export function resolveSyncLocation(filename, roots)
{
	const normalized = path.win32.resolve(filename);
	const matches = roots.filter(root => root.MountPoint && root.UrlNamespace &&
		(normalized.toLowerCase().startsWith(path.win32.resolve(root.MountPoint).toLowerCase() + '\\')))
		.sort((a, b) => b.MountPoint.length - a.MountPoint.length);
	for (const root of matches)
	{
		let base;
		try { base = new URL(root.UrlNamespace); } catch { continue; }
		if (base.protocol !== 'https:' || !/^[a-z0-9-]+\.sharepoint\.com$/i.test(base.hostname) || base.username || base.password) continue;
		const parts = path.win32.relative(root.MountPoint, normalized).split('\\');
		const fileUrl = new URL(parts.map(encodeURIComponent).join('/'), base.href.replace(/\/?$/, '/')).href;
		const folderUrl = new URL(parts.slice(0, -1).map(encodeURIComponent).join('/') + '/', base.href.replace(/\/?$/, '/')).href;
		return {fileUrl, folderUrl};
	}
	return null;
}

export async function getSyncLocation(filename)
{
	if (process.platform !== 'win32') return null;
	if (!rootsPromise)
	{
		// Read only the registered mount points and web namespaces. No tokens,
		// cookies, account databases or private OneDrive protocols are accessed.
		rootsPromise = powershell("$ErrorActionPreference='Stop'; $roots=@(Get-ChildItem 'HKCU:\\Software\\SyncEngines\\Providers\\OneDrive' -ErrorAction SilentlyContinue | ForEach-Object { $p=Get-ItemProperty $_.PSPath; [pscustomobject]@{MountPoint=$p.MountPoint;UrlNamespace=$p.UrlNamespace} }); ConvertTo-Json -InputObject $roots -Compress")
			.then(json => JSON.parse(json || '[]')).catch(() => []);
	}
	return resolveSyncLocation(filename, await rootsPromise);
}

export async function showOneDriveShare(filename, action = 'share')
{
	if (process.platform !== 'win32') throw new Error('Native OneDrive sharing requires Windows');
	if (!['share', 'access'].includes(action)) throw new Error('Invalid sharing action');
	// Invoke OneDrive's existing shell command, just as Explorer does. The
	// user chooses recipients and permissions in Microsoft's own sharing UI.
	const script = "$ErrorActionPreference='Stop'; $p=$env:SHAREMAP_FOLDER; $shell=New-Object -ComObject Shell.Application; $folder=$shell.NameSpace([System.IO.Path]::GetDirectoryName($p)); $item=$folder.ParseName([System.IO.Path]::GetFileName($p)); if($null -eq $item){throw 'Folder unavailable'}; $verbs=@($item.Verbs()); $copy=-1; for($i=0;$i -lt $verbs.Count;$i++){if(($verbs[$i].Name -replace '&','') -eq 'Copy Link'){$copy=$i;break}}; $target=$null; if($env:SHAREMAP_ACTION -eq 'access'){$target=$verbs | Where-Object {($_.Name -replace '&','') -eq 'Manage access'} | Select-Object -First 1} elseif($copy -gt 0){for($i=$copy-1;$i -ge 0;$i--){if(($verbs[$i].Name -replace '&','') -eq 'Share'){$target=$verbs[$i];break}}}; if($null -eq $target){throw 'OneDrive sharing is unavailable. Check that OneDrive is running.'}; $target.DoIt(); Start-Sleep -Milliseconds 750";
	await powershell(script, {SHAREMAP_FOLDER: path.dirname(filename), SHAREMAP_ACTION: action});
}

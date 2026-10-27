import path from 'node:path';
import core from '../shared/journal-core.cjs';

// A shortcut belongs to the profile which joined the map, including custom
// profiles. Windows command-line quoting doubles a trailing backslash.
export function sharedMapShortcutArguments(userData, room)
{
	if (!core.validId(room) || typeof userData !== 'string' || !path.win32.isAbsolute(userData) || /["\x00-\x1f]/.test(userData)) throw new Error('Invalid shared-map shortcut');
	return '--user-data-dir="' + userData.replace(/(\\+)$/, '$1$1') + '" --shared-map=' + room;
}

// Resolve a room before the ordinary draw.io file loader touches its local cache.
export async function prepareServerArguments(args, maps)
{
	const resolved = [];
	for (const arg of args)
	{
		if (typeof arg === 'string' && arg.startsWith('--shared-map=')) resolved.push(await maps.restoreRoom(arg.slice(13)));
		else
		{
			if (typeof arg === 'string' && /\.drawio$/i.test(arg)) await maps.restorePath(arg);
			resolved.push(arg);
		}
	}
	return resolved;
}

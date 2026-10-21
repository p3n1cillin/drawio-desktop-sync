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

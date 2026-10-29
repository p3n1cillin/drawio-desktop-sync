import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import core from '../shared/journal-core.cjs';

const prefix = 'drawio-sync://join/';
export function validateConnection(value)
{
	if (!value || value.version !== 1 || !core.validId(value.room) ||
		!/^[-_a-zA-Z0-9]{40,100}$/.test(value.token) || typeof value.ca !== 'string' || value.ca.length > 16384 ||
		!value.ca.includes('-----BEGIN CERTIFICATE-----')) throw new Error('Invalid shared-diagram link');
	const url = new URL(value.server);
	if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use an HTTPS collaboration server');
	return {version: 1, server: url.origin, room: value.room, token: value.token, ca: value.ca,
		name: String(value.name || 'Shared diagram').slice(0, 120),
		...(value.ownerToken && /^[-_a-zA-Z0-9]{40,100}$/.test(value.ownerToken) ? {ownerToken: value.ownerToken} : {})};
}
export function shareInvite(connection, token = connection.token)
{
	const {ownerToken: _owner, ...shared} = validateConnection({...connection, token});
	return prefix + Buffer.from(JSON.stringify(shared)).toString('base64url');
}
export function parseInvite(text)
{
	if (typeof text !== 'string' || !text.startsWith(prefix) || text.length > 32768) throw new Error('Paste a drawio-sync shared-diagram link');
	try { return validateConnection(JSON.parse(Buffer.from(text.slice(prefix.length), 'base64url').toString('utf8'))); }
	catch { throw new Error('Invalid shared-diagram link'); }
}
export async function serverRequest(connection, route, body, token = connection.ownerToken || connection.token, timeout = 15000)
{
	const url = new URL(route, connection.server);
	const data = Buffer.from(JSON.stringify(body));
	return new Promise((resolve, reject) =>
	{
		const req = https.request(url, {method: 'POST', ca: connection.ca, rejectUnauthorized: true,
			minVersion: 'TLSv1.2', headers: {'Content-Type': 'application/json', 'Content-Length': data.length, Authorization: 'Bearer ' + token}}, res =>
		{
			const chunks = [];
			let bytes = 0;
			res.on('data', chunk =>
			{
				bytes += chunk.length;
				if (bytes > 150 * 1024 * 1024) res.destroy(new Error('Server response exceeds the size limit'));
				else chunks.push(chunk);
			});
			res.on('error', reject);
			res.on('end', () =>
			{
				try
				{
					const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
					if (res.statusCode !== 200) reject(Object.assign(new Error(result.error || 'Server access failed'), {status: res.statusCode}));
					else resolve(result);
				}
				catch { reject(new Error('Invalid response from the collaboration server')); }
			});
		});
		req.setTimeout(timeout, () => req.destroy(new Error('Cannot reach the collaboration server. Your pending edit is kept on this PC; reconnect and retry.')));
		req.on('error', error => reject(new Error(error.code ? 'Cannot connect securely to the collaboration server (' + error.code + '). Your pending edits are kept on this PC.' : error.message)));
		req.end(data);
	});
}
// The server refused the edit itself (revoked link, view-only, invalid edit), so
// retrying can never succeed; network failures and overload are retried.
function refused(error)
{
	return error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
}
async function saveJson(filename, value)
{
	await fs.mkdir(path.dirname(filename), {recursive: true});
	const temp = filename + '.' + randomUUID() + '.tmp';
	try
	{
		const handle = await fs.open(temp, 'wx', 0o600);
		try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
		finally { await handle.close(); }
		await fs.rename(temp, filename);
	}
	finally { await fs.unlink(temp).catch(() => {}); }
}
export class ServerFolder
{
	constructor(filename, connection, client)
	{
		this.filename = filename;
		this.connection = validateConnection(connection);
		this.client = client || randomUUID();
		this.author = randomUUID();
		this.transport = 'server';
		this.records = new Map();
		this.stats = {requests: 0, lastRoundTripMs: 0};
	}
	async request(action, body = {}, timeout)
	{
		const started = Date.now();
		try { return await serverRequest(this.connection, '/v1/maps/' + this.connection.room + '/' + action,
			{...body, author: this.author, client: this.client}, undefined, timeout); }
		finally { this.stats.requests++; this.stats.lastRoundTripMs = Date.now() - started; }
	}
	async open()
	{
		// A lost response must not turn a durable edit into a second operation.
		const directory = path.dirname(this.filename);
		for (const name of (await fs.readdir(directory)).filter(name => /^outbox-[a-f0-9-]{36}\.json$/.test(name)).sort())
		{
			const pendingPath = path.join(directory, name);
			const pending = JSON.parse(await fs.readFile(pendingPath, 'utf8'));
			try { await serverRequest(this.connection, '/v1/maps/' + this.connection.room + '/append', pending); }
			catch (error) { if (!refused(error)) throw error; }
			await fs.unlink(pendingPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
		}
		const info = await this.request('open');
		this.manifest = info.manifest;
		this.incremental = !!info.capabilities?.incrementalSync;
		this.role = info.role || 'edit';
		return {...info, role: this.role, author: this.author, client: this.client, transport: this.transport,
			server: this.connection.server, owner: !!this.connection.ownerToken};
	}
	async updates()
	{
		if (!this.incremental) return this.request('scan');
		const update = await this.request('sync', {cursor: this.cursor || 0, epoch: this.epoch});
		for (const op of update.records) core.validate(op, this.manifest.room);
		this.cursor = update.cursor;
		this.epoch = update.epoch;
		this.peers = update.peers;
		return update.records;
	}
	async scan()
	{
		for (const op of await this.updates()) this.records.set(op.id, op);
		return [...this.records.values()];
	}
	async append(patch, parents, name, operationId, email)
	{
		// Never queue an edit in the durable outbox that the server must refuse.
		if (this.role === 'view') throw new Error('This link is view-only');
		const record = {patch, parents, name, email, operationId: operationId || randomUUID(), author: this.author, client: this.client};
		const pendingPath = path.join(path.dirname(this.filename), 'outbox-' + record.operationId + '.json');
		await saveJson(pendingPath, record);
		const sent = this.request('append', record);
		const settled = await sent.then(() => true, error => refused(error));
		if (settled) await fs.unlink(pendingPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
		return sent;
	}
	snapshot(xml, heads) { return this.request('snapshot', {xml, heads}); }
	// This desktop's own copy of the map after the first `count` server edits, so
	// reopening replays only newer edits. Copies written by other desktops are never used.
	async launchState()
	{
		try
		{
			const state = JSON.parse(await fs.readFile(path.join(path.dirname(this.filename), 'launch-state.json'), 'utf8'));
			return state.room === this.connection.room && Number.isSafeInteger(state.count) && state.count > 0 && core.validId(state.last) && typeof state.xml === 'string' ? state : null;
		}
		catch { return null; }
	}
	async saveLaunchState({count, last, xml})
	{
		if (!Number.isSafeInteger(count) || count < 1 || !core.validId(last) || typeof xml !== 'string' || xml.length > 32 * 1024 * 1024) throw new Error('Invalid launch state');
		await saveJson(path.join(path.dirname(this.filename), 'launch-state.json'), {room: this.connection.room, count, last, xml});
		return true;
	}
	history() { return this.request('history'); }
	activity(name, page, selection, editing, editingCell, pointer, email) { return this.request('activity', {name, page, selection, editing, editingCell, pointer, email}); }
	leave() { return this.request('leave'); }
	diagnostics() { return this.request('diagnostics'); }
	// Held by the server until edits, comments or presence differ from what the
	// editor last saw (or 20 seconds pass).
	watch({cursor, epoch, comments, presence} = {}) { return this.request('watch', {cursor, epoch, comments, presence}, 30000); }
	comments() { return this.request('comments'); }
	comment(body) { return this.request('comment', body); }
	people() { return this.request('people'); }
	async shareLink(kind = 'edit')
	{
		if (kind !== 'view' || this.role === 'view') return shareInvite(this.connection);
		const {token} = await this.request('viewLink');
		return shareInvite(this.connection, token);
	}
	async rotateLink(kind = 'edit')
	{
		const {token} = await this.request('rotate', {kind});
		if (kind === 'view') return true;
		this.connection.token = token;
		await saveJson(path.join(path.dirname(this.filename), 'connection.json'), this.connection);
		return true;
	}
}

export class ServerMaps
{
	constructor(userData, mapsDirectory = path.join(userData, 'server-maps'), options = {})
	{
		this.directory = mapsDirectory;
		this.setupPath = path.join(userData, 'server-setup.json');
		this.readFile = options.readFile || fs.readFile;
		this.wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
		this.onReadRetry = options.onReadRetry || (() => {});
	}
	async readConnection(room)
	{
		if (!core.validId(room)) throw new Error('Invalid shared-diagram shortcut');
		const filename = path.join(this.directory, room, 'connection.json');
		let raw;
		for (let attempt = 0; ; attempt++)
		{
			try { raw = await this.readFile(filename, 'utf8'); break; }
			catch (error)
			{
				// A briefly locked/unavailable profile file is not a lost invitation.
				if (attempt < 3 && ['ENOENT', 'EBUSY', 'EACCES', 'EPERM'].includes(error.code))
				{
					this.onReadRetry({code: error.code, attempt: attempt + 1, room});
					await this.wait([50, 150, 400][attempt]);
					continue;
				}
				if (error.code === 'ENOENT') throw new Error('This PC has no saved connection for this shared diagram. Join using its invitation link, then reopen the shortcut.', {cause: error});
				throw new Error('Cannot read the saved shared-diagram connection (' + (error.code || 'file access error') + '). Retry or check access to your app profile. The shared diagram has not been changed.', {cause: error});
			}
		}
		let connection;
		try { connection = validateConnection(JSON.parse(raw)); }
		catch { throw new Error('The saved shared-diagram connection is invalid or damaged. Restore its connection settings from backup. The shared diagram has not been changed.'); }
		if (connection.room !== room) throw new Error('The shared-diagram cache belongs to a different room');
		return connection;
	}
	async cache(connection, client)
	{
		connection = validateConnection(connection);
		const directory = path.join(this.directory, connection.room);
		await fs.mkdir(directory, {recursive: true});
		try
		{
			const previous = validateConnection(JSON.parse(await fs.readFile(path.join(directory, 'connection.json'), 'utf8')));
			if (!connection.ownerToken && previous.ownerToken && previous.server === connection.server && previous.ca === connection.ca) connection.ownerToken = previous.ownerToken;
		}
		catch (error) { if (error.code !== 'ENOENT') throw error; }
		// Fetch the actual title from the server, rather than trusting link text.
		const probe = new ServerFolder(path.join(directory, 'map.drawio'), connection, client);
		const info = await probe.open();
		const safeName = String(info.name || 'Shared diagram').replace(/[^a-zA-Z0-9 _.-]/g, '_').replace(/\.drawio$/i, '').replace(/[. ]+$/, '');
		const filename = path.join(directory, 'Diagram - ' + (safeName || 'Shared diagram') + '.drawio');
		connection.name = info.name;
		// Keep a launchable base cache. Server snapshots, never this file, are authoritative.
		await fs.writeFile(filename, info.manifest.base, {flag: 'wx'}).catch(error => { if (error.code !== 'EEXIST') throw error; });
		await saveJson(path.join(directory, 'connection.json'), connection);
		return filename;
	}
	async join(invite, client) { return this.cache(parseInvite(invite), client); }
	async restoreRoom(room)
	{
		if (!core.validId(room)) throw new Error('Invalid shared-diagram shortcut');
		const connection = await this.readConnection(room);
		const files = await fs.readdir(path.join(this.directory, room));
		// Caches joined before 32.6.1 are named "Map - …"; recents and shortcuts still point at them.
		const name = files.find(name => /^(?:Diagram|Map) - .*\.drawio$/i.test(name));
		return name ? path.join(this.directory, room, name) : this.cache(connection);
	}
	async restorePath(filename)
	{
		try { await fs.access(filename); return; }
		catch (error) { if (error.code !== 'ENOENT') throw error; }
		const folder = await this.open(filename);
		if (folder)
		{
			const info = await folder.open();
			await fs.writeFile(filename, info.manifest.base, {flag: 'wx'}).catch(error => { if (error.code !== 'EEXIST') throw error; });
		}
	}
	async create({xml, name}, client)
	{
		let setup;
		try { setup = JSON.parse(await fs.readFile(this.setupPath, 'utf8')); }
		catch { throw new Error('This PC has no server setup. Ask the server administrator to configure it, or use Open shared diagram with an invitation link.'); }
		const result = await serverRequest(setup, '/v1/create', {xml, name}, setup.adminToken);
		return this.cache({version: 1, server: setup.server, ca: setup.ca, ...result}, client);
	}
	async open(filename, client)
	{
		const relative = path.relative(this.directory, filename);
		if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
		const parts = relative.split(path.sep);
		if (parts.length !== 2 || !core.validId(parts[0]) || !/\.drawio$/i.test(parts[1])) return null;
		const connection = await this.readConnection(parts[0]);
		return new ServerFolder(filename, connection, client);
	}
}

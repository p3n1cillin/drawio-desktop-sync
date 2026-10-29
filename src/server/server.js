// Private HTTPS collaboration service. Diagram data never passes through OneDrive.
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes, randomUUID, createHash, timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {JournalStore} from './journal-store.js';
import core from '../shared/journal-core.cjs';

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const maxBody = 100 * 1024 * 1024;
const watchMs = 20000;
// Viewers can read, follow presence and see history and comments, but never write.
const viewActions = new Set(['open', 'scan', 'sync', 'history', 'activity', 'leave', 'diagnostics', 'comments', 'people', 'watch']);
function check(condition, message, status = 400)
{
	if (!condition) throw Object.assign(new Error(message), {status});
}
async function readBody(req)
{
	let size = 0;
	const chunks = [];
	for await (const chunk of req)
	{
		size += chunk.length;
		check(size <= maxBody, 'Request exceeds the size limit', 413);
		chunks.push(chunk);
	}
	try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
	catch { throw Object.assign(new Error('Invalid JSON request'), {status: 400}); }
}
async function writeJson(filename, value)
{
	const temporary = filename + '.' + randomUUID() + '.tmp';
	try
	{
		const handle = await fs.open(temporary, 'wx', 0o600);
		try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
		finally { await handle.close(); }
		await fs.rename(temporary, filename);
	}
	finally { await fs.unlink(temporary).catch(() => {}); }
}
async function readJson(filename, fallback)
{
	try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
	catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
// Names and addresses come from each desktop's signed-in account. They label
// people for presence, history, comments and mentions; links remain the credential.
function emailOf(value)
{
	return typeof value === 'string' && value.length <= 200 && /^[^\s@<>"']+@[^\s@<>"']+\.[A-Za-z]{2,}$/.test(value) ? value.toLowerCase() : '';
}
function nameOf(value, fallback = 'Editor')
{
	return String(value || fallback).replace(/[\x00-\x1f]/g, '').slice(0, 80);
}
function pointOf(value)
{
	return value && Number.isFinite(value.x) && Number.isFinite(value.y) && Math.abs(value.x) < 1e7 && Math.abs(value.y) < 1e7 ?
		{x: Math.round(value.x), y: Math.round(value.y)} : null;
}
function anchorOf(value)
{
	if (value == null) return null;
	check(typeof value === 'object' && !Array.isArray(value) && JSON.stringify(value).length <= 2000, 'Invalid comment anchor');
	return value;
}

export async function createCollaborationServer({directory, key, cert, adminToken})
{
	check(typeof adminToken === 'string' && adminToken.length >= 40, 'Set a strong administrator token');
	await fs.mkdir(directory, {recursive: true, mode: 0o700});
	const queues = new Map();
	const rooms = new Map();
	const lastUsed = new Map();
	const epoch = randomUUID();
	async function roomFor(id)
	{
		lastUsed.set(id, Date.now());
		if (!rooms.has(id)) rooms.set(id, (async () =>
		{
			const roomDir = path.join(directory, id);
			const access = JSON.parse(await fs.readFile(path.join(roomDir, 'access.json'), 'utf8'));
			const folder = new JournalStore(path.join(roomDir, 'map.drawio'));
			await folder.open();
			const records = (await folder.scan()).sort(core.compare);
			return {folder, access, records, presence: new Map(), waiters: new Set(), commentVersion: 0, presenceVersion: 0,
				comments: (await readJson(path.join(roomDir, 'comments.json'), {comments: []})).comments,
				people: (await readJson(path.join(roomDir, 'people.json'), {people: []})).people};
		})().catch(error => { rooms.delete(id); lastUsed.delete(id); throw error; }));
		return rooms.get(id);
	}
	function peers(room)
	{
		const clients = new Map();
		for (const peer of [...room.presence.values()].sort((a, b) => b.updated - a.updated))
		{
			if (Date.now() - peer.updated > 35000) room.presence.delete(peer.author);
			else if (!clients.has(peer.client)) clients.set(peer.client, peer);
		}
		return [...clients.values()];
	}
	// Wakes held watch requests so other desktops fetch the change at once.
	function wake(room)
	{
		clearTimeout(room.wakeTimer);
		room.wakeTimer = null;
		for (const done of [...room.waiters]) done();
	}
	// Pointer and selection updates are batched so a moving mouse does not wake
	// every desktop for each event; edits and comments wake immediately.
	function wakeSoon(room)
	{
		room.wakeTimer = room.wakeTimer || setTimeout(() => wake(room), 100);
	}
	async function remember(room, roomDir, name, email)
	{
		if (!email) return;
		const known = room.people.find(person => person.email === email);
		if (known?.name === name) return;
		if (known) known.name = name;
		else room.people.push({email, name});
		room.people = room.people.slice(-500);
		await writeJson(path.join(roomDir, 'people.json'), {people: room.people});
	}
	function visibleComments(room)
	{
		return room.comments.filter(comment => !comment.deleted);
	}
	async function serial(id, action)
	{
		const previous = queues.get(id) || Promise.resolve();
		const next = previous.catch(() => {}).then(action);
		queues.set(id, next);
		try { return await next; }
		finally { if (queues.get(id) === next) queues.delete(id); }
	}
	const server = https.createServer({key, cert, minVersion: 'TLSv1.2'}, async (req, res) =>
	{
		res.setHeader('Cache-Control', 'no-store');
		res.setHeader('Content-Type', 'application/json');
		res.setHeader('X-Content-Type-Options', 'nosniff');
		try
		{
			if (req.method === 'GET' && req.url === '/health')
			{
				res.end(JSON.stringify({service: 'drawio-desktop-sync', protocol: 2}));
				return;
			}
			// No browser cookie authentication or CORS: only desktop bearer credentials.
			check(!req.headers.origin, 'Browser requests are not supported', 403);
			check(req.method === 'POST', 'Endpoint not found', 404);
			const token = (req.headers.authorization || '').replace(/^Bearer /, '');
			if (req.url === '/v1/create')
			{
				check(equal(hash(token), hash(adminToken)), 'Access denied', 401);
				const input = await readBody(req);
				check(typeof input.xml === 'string' && Buffer.byteLength(input.xml) <= 16 * 1024 * 1024 && /^\s*<mxfile\b/.test(input.xml), 'Use a draw.io diagram under 16 MiB');
				const id = randomUUID();
				const roomDir = path.join(directory, id);
				await fs.mkdir(roomDir, {mode: 0o700});
				// Old local transport markers must not identify a new server session.
				const xml = input.xml.replace(/(<mxfile\b[^>]*)(>)/, tag => tag.replace(/\s+sharemap-(?:room|heads)="[^"]*"/g, ''));
				const filename = path.join(roomDir, 'map.drawio');
				await fs.writeFile(filename, xml, {mode: 0o600, flag: 'wx'});
				const folder = new JournalStore(filename);
				await folder.open(xml);
				const editToken = secret();
				const ownerToken = secret();
				const name = String(input.name || 'Shared diagram').replace(/[\x00-\x1f]/g, '').slice(0, 120);
				await writeJson(path.join(roomDir, 'access.json'), {name, editHash: hash(editToken), ownerHash: hash(ownerToken)});
				res.end(JSON.stringify({room: id, token: editToken, ownerToken, name}));
				return;
			}
			const match = /^\/v1\/maps\/([a-f0-9-]{36})\/(open|scan|sync|append|snapshot|history|activity|leave|diagnostics|rotate|watch|comments|comment|people|viewLink)$/.exec(req.url);
			check(match && core.validId(match[1]), 'Endpoint not found', 404);
			const [, id, action] = match;
			const roomDir = path.join(directory, id);
			let room;
			try { room = await roomFor(id); }
			catch { throw Object.assign(new Error('Diagram is unavailable'), {status: 404}); }
			// A view link is a read credential; it is kept so editors can share it again.
			const authorize = () =>
			{
				const role = equal(hash(token), room.access.ownerHash) ? 'owner' : equal(hash(token), room.access.editHash) ? 'edit' :
					equal(token, room.access.viewToken) ? 'view' : null;
				check(role, 'This link was revoked or access is unavailable', 401);
				check(role !== 'view' || viewActions.has(action), 'This link is view-only', 403);
				return role;
			};
			authorize();
			const input = await readBody(req);
			check(core.validId(input.author) && core.validId(input.client), 'Invalid editor identity');
			const email = emailOf(input.email);
			const name = nameOf(input.name);
			if (action === 'watch')
			{
				// Held outside the room queue: answers as soon as edits, comments or presence change.
				const state = () => ({epoch, cursor: room.records.length, comments: room.commentVersion, presence: room.presenceVersion});
				const current = state();
				if (input.epoch === current.epoch && input.cursor === current.cursor && input.comments === current.comments && input.presence === current.presence)
				{
					await new Promise(resolve =>
					{
						const done = () => { clearTimeout(timer); room.waiters.delete(done); resolve(); };
						const timer = setTimeout(done, watchMs);
						room.waiters.add(done);
						res.once('close', done);
					});
				}
				lastUsed.set(id, Date.now());
				authorize();
				res.end(JSON.stringify({...state(), peers: peers(room)}));
				return;
			}
			const result = await serial(id, async () =>
			{
				const role = authorize();
				const {folder} = room;
				folder.author = input.author;
				folder.client = input.client;
				switch (action)
				{
					case 'open': return {manifest: folder.manifest, name: room.access.name, role,
						capabilities: {incrementalSync: true, livePresence: true, conflicts: true, versionHistory: true, watch: true, comments: true, viewLinks: true}};
					case 'scan': return room.records;
					case 'sync':
					{
						const from = input.epoch === epoch && Number.isSafeInteger(input.cursor) && input.cursor >= 0 && input.cursor <= room.records.length ? input.cursor : 0;
						return {epoch, cursor: room.records.length, records: room.records.slice(from), peers: peers(room)};
					}
					case 'append':
					{
						check(core.validId(input.operationId), 'Invalid operation identity');
						const previous = folder.cache.get(input.operationId);
						if (previous)
						{
							check(previous.author === input.author && JSON.stringify(previous.patch) === JSON.stringify(input.patch) && JSON.stringify(previous.parents) === JSON.stringify(input.parents), 'Operation identity was reused with different edits', 409);
							return previous;
						}
						const op = await folder.append(input.patch, input.parents, name, input.operationId, email);
						room.records.push(op);
						await remember(room, roomDir, name, email);
						wake(room);
						return op;
					}
					case 'snapshot': return folder.snapshot(input.xml, input.heads);
					case 'history': return folder.history();
					case 'activity':
					{
						const peer = {version: 1, room: folder.manifest.room, author: input.author, client: input.client, name, email, role,
							updated: Date.now(), page: String(input.page || '').slice(0, 200),
							selection: Array.isArray(input.selection) ? input.selection.filter(id => typeof id === 'string').slice(0, 30).map(id => id.slice(0, 200)) : [],
							editing: !!input.editing, editingCell: String(input.editingCell || '').slice(0, 200), pointer: pointOf(input.pointer)};
						const previous = room.presence.get(input.author);
						room.presence.set(input.author, peer);
						const {updated: _a, ...next} = peer;
						const {updated: _b, ...last} = previous || {};
						if (JSON.stringify(next) !== JSON.stringify(last)) { room.presenceVersion++; wakeSoon(room); }
						await remember(room, roomDir, name, email);
						return peers(room);
					}
					case 'leave': room.presence.delete(input.author); room.presenceVersion++; wake(room); return true;
					case 'diagnostics':
					{
						const report = await folder.diagnostics();
						delete report.localPath;
						return {...report, presence: peers(room).map(({selection: _selection, page: _page, pointer: _pointer, email: _email, ...peer}) => ({...peer, editingCell: undefined, ageSeconds: Math.round((Date.now() - peer.updated) / 1000)})),
							transport: 'server', serverBuild: '32.6.0'};
					}
					case 'rotate':
					{
						check(role === 'owner', 'Only the diagram owner can revoke sharing links', 403);
						if (input.kind === 'view')
						{
							const {viewToken: _view, ...updated} = room.access;
							await writeJson(path.join(roomDir, 'access.json'), updated);
							room.access = updated;
							wake(room);
							return {};
						}
						const newToken = secret();
						const updated = {...room.access, editHash: hash(newToken)};
						await writeJson(path.join(roomDir, 'access.json'), updated);
						room.access = updated;
						wake(room);
						return {token: newToken};
					}
					case 'viewLink':
					{
						if (!room.access.viewToken)
						{
							const updated = {...room.access, viewToken: secret()};
							await writeJson(path.join(roomDir, 'access.json'), updated);
							room.access = updated;
						}
						return {token: room.access.viewToken};
					}
					case 'people': return room.people;
					case 'comments': return {version: room.commentVersion, comments: visibleComments(room)};
					case 'comment':
					{
						const author = {id: email || input.client, name, email};
						const content = String(input.content ?? '');
						check(content.length <= 10000, 'Comments are limited to 10,000 characters');
						const now = Date.now();
						const find = commentId => room.comments.find(comment => comment.id === commentId && !comment.deleted);
						let item;
						switch (input.op)
						{
							case 'add':
								item = {id: randomUUID(), parent: null, content, anchor: anchorOf(input.anchor), author, created: now, modified: now, resolved: false};
								break;
							case 'reply':
							{
								const parent = find(input.parent);
								check(parent && !parent.parent, 'The comment was deleted', 404);
								item = {id: randomUUID(), parent: parent.id, content, anchor: null, author, created: now, modified: now, resolved: false};
								if (input.resolve) parent.resolved = true;
								if (input.reopen) parent.resolved = false;
								break;
							}
							case 'edit':
							case 'delete':
							{
								const target = find(input.comment);
								check(target, 'The comment was deleted', 404);
								check(target.author.id === author.id || (input.op === 'delete' && role === 'owner'), 'You can only change your own comments', 403);
								if (input.op === 'edit') { target.content = content; target.modified = now; }
								else for (const comment of room.comments) if (comment.id === target.id || comment.parent === target.id) { comment.deleted = true; comment.content = ''; }
								break;
							}
							default: check(false, 'Unknown comment action');
						}
						if (item)
						{
							check(room.comments.length < 5000, 'This diagram has reached its comment limit');
							room.comments.push(item);
						}
						await writeJson(path.join(roomDir, 'comments.json'), {comments: room.comments});
						await remember(room, roomDir, name, email);
						room.commentVersion++;
						wake(room);
						return {id: item?.id || input.comment};
					}
				}
			});
			res.end(JSON.stringify(result));
		}
		catch (error)
		{
			res.statusCode = error.status || 500;
			// Do not return paths, input or internal traces to an unauthenticated caller.
			res.end(JSON.stringify({error: error.status ? error.message : 'The server could not save this request. Retry or contact its administrator.'}));
			if (!error.status) console.error('Collaboration request failed:', error.code || error.name);
		}
	});
	server.requestTimeout = 30000;
	server.headersTimeout = 10000;
	// Each open map holds one watch request.
	server.maxConnections = 500;
	const sweep = setInterval(() =>
	{
		for (const [id, used] of lastUsed) if (Date.now() - used > 300000 && !queues.has(id))
		{
			rooms.delete(id);
			lastUsed.delete(id);
		}
	}, 60000);
	sweep.unref();
	server.on('close', () => clearInterval(sweep));
	return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
	const configPath = process.env.DRAWIO_SYNC_CONFIG;
	if (!configPath) throw new Error('Set DRAWIO_SYNC_CONFIG to the private server configuration');
	const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
	const service = await createCollaborationServer({...config,
		key: await fs.readFile(config.key), cert: await fs.readFile(config.cert)});
	service.listen(config.port || 9443, config.host || '0.0.0.0', () => console.log('drawio-desktop-sync service ready'));
	for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => service.close(() => process.exit(0)));
}

// Private HTTPS collaboration service. Diagram data never passes through OneDrive.
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes, randomUUID, createHash, timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {SharedFolder} from '../main/shared-folder.js';
import core from '../shared/journal-core.cjs';

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const maxBody = 100 * 1024 * 1024;
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

export async function createCollaborationServer({directory, key, cert, adminToken})
{
	check(typeof adminToken === 'string' && adminToken.length >= 40, 'Set a strong administrator token');
	await fs.mkdir(directory, {recursive: true, mode: 0o700});
	const queues = new Map();
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
				res.end(JSON.stringify({service: 'drawio-desktop-sync', protocol: 1}));
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
				const folder = new SharedFolder(filename);
				await folder.open(xml);
				const editToken = secret();
				const ownerToken = secret();
				const name = String(input.name || 'Shared map').replace(/[\x00-\x1f]/g, '').slice(0, 120);
				await writeJson(path.join(roomDir, 'access.json'), {name, editHash: hash(editToken), ownerHash: hash(ownerToken)});
				res.end(JSON.stringify({room: id, token: editToken, ownerToken, name}));
				return;
			}
			const match = /^\/v1\/maps\/([a-f0-9-]{36})\/(open|scan|append|snapshot|activity|leave|diagnostics|rotate)$/.exec(req.url);
			check(match && core.validId(match[1]), 'Endpoint not found', 404);
			const [, id, action] = match;
			const roomDir = path.join(directory, id);
			let access;
			try { access = JSON.parse(await fs.readFile(path.join(roomDir, 'access.json'), 'utf8')); }
			catch { throw Object.assign(new Error('Map is unavailable'), {status: 404}); }
			const owner = equal(hash(token), access.ownerHash);
			check(owner || equal(hash(token), access.editHash), 'This link was revoked or access is unavailable', 401);
			const input = await readBody(req);
			check(core.validId(input.author) && core.validId(input.client), 'Invalid editor identity');
			const result = await serial(id, async () =>
			{
				const folder = new SharedFolder(path.join(roomDir, 'map.drawio'), input.client);
				await folder.open();
				folder.author = input.author;
				switch (action)
				{
					case 'open': return {manifest: folder.manifest, name: access.name};
					case 'scan': return folder.scan();
					case 'append':
					{
						check(core.validId(input.operationId), 'Invalid operation identity');
						const records = await folder.scan();
						const previous = records.find(op => op.id === input.operationId);
						if (previous)
						{
							check(previous.author === input.author && JSON.stringify(previous.patch) === JSON.stringify(input.patch) && JSON.stringify(previous.parents) === JSON.stringify(input.parents), 'Operation identity was reused with different edits', 409);
							return previous;
						}
						return folder.append(input.patch, input.parents, input.name, input.operationId);
					}
					case 'snapshot': return folder.snapshot(input.xml, input.heads);
					case 'activity': return folder.activity(input.name, input.page, input.selection);
					case 'leave': await folder.leave(); return true;
					case 'diagnostics':
					{
						const report = await folder.diagnostics();
						delete report.localPath;
						return {...report, transport: 'server', serverBuild: '32.5.6'};
					}
					case 'rotate':
					{
						check(owner, 'Only the map owner can revoke sharing links', 403);
						const newToken = secret();
						await writeJson(path.join(roomDir, 'access.json'), {...access, editHash: hash(newToken)});
						return {token: newToken};
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
	server.maxConnections = 100;
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

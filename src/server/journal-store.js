import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import core from '../shared/journal-core.cjs';
import conflicts from '../shared/conflicts.cjs';

const maxFile = 16 * 1024 * 1024;
// JSON may expand a control character into six ASCII bytes.
const maxManifest = 6 * maxFile + 1024;
const maxJournal = 128 * 1024 * 1024;

async function replaceFile(temp, target)
{
	for (let attempt = 0; ; attempt++)
	{
		try { await fs.rename(temp, target); return; }
		catch (e)
		{
			// The filesystem or antivirus can briefly hold a Windows file open while
			// inspecting it. Keep the complete temp file until a bounded retry.
			if (attempt >= 5 || !['EACCES', 'EBUSY', 'EPERM'].includes(e.code)) throw e;
			await delay(25 * (2 ** attempt));
		}
	}
}

export class JournalStore
{
	constructor(filename, clientId)
	{
		this.filename = path.resolve(filename);
		this.directory = this.filename + '.collab';
		this.author = randomUUID();
		this.client = core.validId(clientId) ? clientId : this.author;
		this.cache = new Map();
		this.clock = 0;
		this.chain = Promise.resolve();
	}

	async safePath(name)
	{
		const dir = await fs.lstat(this.directory);
		if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('Unsafe collaboration directory');
		const parent = await fs.realpath(path.dirname(this.directory));
		if (await fs.realpath(this.directory) !== path.join(parent, path.basename(this.directory)))
		{
			throw new Error('Collaboration directory was redirected');
		}
		if (path.basename(name) !== name) throw new Error('Invalid journal filename');
		const target = path.join(this.directory, name);
		try
		{
			const stat = await fs.lstat(target);
			if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe journal file');
		}
		catch (e)
		{
			if (e.code !== 'ENOENT') throw e;
		}
		return target;
	}

	async readJson(name, limit = maxFile)
	{
		const target = await this.safePath(name);
		const stat = await fs.stat(target);
		if (stat.size > limit) throw new Error('Shared file exceeds the size limit');
		return JSON.parse(await fs.readFile(target, 'utf8'));
	}

	async immutable(name, value)
	{
		const target = await this.safePath(name);
		const temp = await this.safePath('pending-' + randomUUID() + '.tmp');
		const handle = await fs.open(temp, 'wx');
		try
		{
			try
			{
				await handle.writeFile(JSON.stringify(value), 'utf8');
				await handle.sync();
			}
			finally { await handle.close(); }
			// Link is atomic and refuses an existing destination. Records are
			// immutable, and incomplete temp files are never read by peers.
			await fs.link(temp, target);
		}
		finally { await fs.unlink(temp).catch(() => {}); }
	}

	async open(createXml)
	{
		if (createXml != null)
		{
			if (typeof createXml !== 'string' || Buffer.byteLength(createXml) > maxFile)
			{
				throw new Error('Diagram exceeds the 16 MiB shared editing limit');
			}
			await fs.mkdir(this.directory).catch(e => { if (e.code !== 'EEXIST') throw e; });
			const originalHash = createHash('sha256').update(await fs.readFile(this.filename)).digest('hex');
			const manifest = {version: 1, room: randomUUID(), base: createXml, originalHash};
			await this.immutable('manifest.json', manifest).catch(e => { if (e.code !== 'EEXIST') throw e; });
		}
		try { this.manifest = await this.readJson('manifest.json', maxManifest); }
		catch (e)
		{
			if (e.code === 'ENOENT' && createXml == null) return null;
			throw e;
		}
		if (this.manifest.version !== 1 || !core.validId(this.manifest.room) ||
			typeof this.manifest.base !== 'string' || Buffer.byteLength(this.manifest.base) > maxFile ||
			!/^[a-f0-9]{64}$/.test(this.manifest.originalHash)) throw new Error('Invalid collaboration manifest');
		await this.readCurrent();
		return {manifest: this.manifest, author: this.author, client: this.client};
	}

	async readCurrent()
	{
		const stat = await fs.lstat(this.filename);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxFile) throw new Error('Unsafe or oversized diagram file');
		const current = await fs.readFile(this.filename, 'utf8');
		const hash = createHash('sha256').update(current).digest('hex');
		if (hash !== this.manifest.originalHash)
		{
			try { await this.readJson('snapshot-' + hash + '.json', 1024 * 1024); }
			catch
			{
				throw new Error('The server map changed outside collaboration. Preserve that copy and restore a consistent server backup before retrying.');
			}
		}
		return current;
	}

	async scan(audit = false)
	{
		if (this.loaded && !audit) return [...this.cache.values()];
		const manifest = await this.readJson('manifest.json', maxManifest);
		if (manifest.room !== this.manifest.room || manifest.base !== this.manifest.base)
		{
			throw new Error('Collaboration manifest changed. Stop editing and restore the original manifest.');
		}
		await this.safePath('manifest.json');
		const names = await fs.readdir(this.directory);
		const edits = names.filter(name => name.startsWith('edit-') && name.endsWith('.json'));
		if (edits.length > 10000) throw new Error('Journal limit reached. Export a copy to start a new shared map.');
		let bytes = 0;
		const current = new Set();
		for (const name of edits)
		{
			const target = await this.safePath(name);
			const stat = await fs.stat(target);
			bytes += stat.size;
			if (stat.size > core.maxBytes || bytes > maxJournal) throw new Error('Journal size limit reached');
			const op = await this.readJson(name, core.maxBytes);
			core.validate(op, this.manifest.room);
			if (this.cache.has(op.id) && JSON.stringify(this.cache.get(op.id)) !== JSON.stringify(op))
			{
				throw new Error('A saved edit was modified. Restore the original record from a server backup.');
			}
			this.cache.set(op.id, op);
			current.add(op.id);
			this.clock = Math.max(this.clock, op.clock);
		}
		if ([...this.cache.keys()].some(id => !current.has(id)))
		{
			throw new Error('Saved edits are missing. Restore the server edit history from a backup.');
		}
		this.loaded = true;
		return [...this.cache.values()];
	}

	append(patch, parents, name, operationId = randomUUID())
	{
		const write = async () =>
		{
			await this.scan();
			if (this.cache.size >= 10000) throw new Error('Edit history limit reached. Save an archive copy before starting a new shared map.');
			const ordered = core.order([...this.cache.values()], this.manifest.room);
			const ready = new Set(ordered.ready.map(op => op.id));
			if (!Array.isArray(parents) || !parents.every(id => ready.has(id)))
			{
				throw new Error('Wait for the earlier edits to finish downloading');
			}
			const op = {version: 1, room: this.manifest.room, id: operationId,
				author: this.author, name: String(name || 'Editor').slice(0, 80),
				clock: ++this.clock, parents, patch};
			const overlapping = conflicts.detect([...this.cache.values()], parents, patch, this.author);
			if (overlapping.length) op.conflicts = overlapping;
			core.validate(op, this.manifest.room);
			await this.immutable('edit-' + op.id + '.json', op);
			this.cache.set(op.id, op);
			return op;
		};
		const task = this.chain.then(write);
		this.chain = task.catch(() => {});
		return task;
	}

	async snapshot(xml, heads)
	{
		if (typeof xml !== 'string' || Buffer.byteLength(xml) > maxFile ||
			!Array.isArray(heads) || !heads.every(core.validId)) throw new Error('Invalid shared snapshot');
		const records = await this.scan();
		const currentHeads = core.order(records, this.manifest.room).heads;
		if (JSON.stringify([...heads].sort()) !== JSON.stringify(currentHeads)) return false;
		const current = await this.readCurrent();
		if (current === xml) return true;
		const hashOf = text => createHash('sha256').update(text).digest('hex');
		await this.immutable('snapshot-' + hashOf(xml) + '.json', {heads}).catch(e => { if (e.code !== 'EEXIST') throw e; });
		// The .drawio file is a materialized view. The authoritative immutable journal is replayed on every join. Never use this file as an operation source after joining.
		const temp = path.join(path.dirname(this.filename), '.sharemap-' + randomUUID() + '.tmp');
		const handle = await fs.open(temp, 'wx');
		try
		{
			try { await handle.writeFile(xml, 'utf8'); await handle.sync(); }
			finally { await handle.close(); }
			await replaceFile(temp, this.filename);
		}
		finally { await fs.unlink(temp).catch(() => {}); }
		return true;
	}

	async diagnostics()
	{
		let records = [];
		let error = null;
		try { records = await this.scan(true); }
		catch (e) { error = e.message; }
		const ordered = core.order(records, this.manifest.room);
		return {version: 1, observedAt: new Date().toISOString(), localPath: this.filename,
			room: this.manifest.room, client: this.client, author: this.author, error,
			edits: {count: records.length, pending: ordered.pending, heads: ordered.heads,
				fingerprint: createHash('sha256').update(records.map(op => op.id).sort().join('\n')).digest('hex'),
				recent: [...records].sort(core.compare).slice(-30).map(op => ({id: op.id, author: op.author, name: op.name, clock: op.clock}))},
			presence: []};
	}

}

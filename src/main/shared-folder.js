import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import core from '../shared/journal-core.cjs';

const maxFile = 16 * 1024 * 1024;
const maxJournal = 128 * 1024 * 1024;

export class SharedFolder
{
	constructor(filename)
	{
		this.filename = path.resolve(filename);
		this.directory = this.filename + '.collab';
		this.author = randomUUID();
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
			await handle.writeFile(JSON.stringify(value), 'utf8');
			await handle.sync();
		}
		finally { await handle.close(); }
		try
		{
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
		try { this.manifest = await this.readJson('manifest.json', maxFile + 1024 * 1024); }
		catch (e)
		{
			if (e.code === 'ENOENT' && createXml == null) return null;
			throw e;
		}
		if (this.manifest.version !== 1 || !core.validId(this.manifest.room) ||
			typeof this.manifest.base !== 'string') throw new Error('Invalid collaboration manifest');
		return {manifest: this.manifest, author: this.author};
	}

	async scan()
	{
		const manifest = await this.readJson('manifest.json', maxFile + 1024 * 1024);
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
				throw new Error('A saved edit was modified. Restore its original version in SharePoint.');
			}
			this.cache.set(op.id, op);
			current.add(op.id);
			this.clock = Math.max(this.clock, op.clock);
		}
		if ([...this.cache.keys()].some(id => !current.has(id)))
		{
			throw new Error('Saved edits are missing. Wait for OneDrive or restore the collaboration folder.');
		}
		return [...this.cache.values()];
	}

	append(patch, parents, name)
	{
		const write = async () =>
		{
			await this.scan();
			const ordered = core.order([...this.cache.values()], this.manifest.room);
			const ready = new Set(ordered.ready.map(op => op.id));
			if (!Array.isArray(parents) || !parents.every(id => ready.has(id)))
			{
				throw new Error('Wait for the earlier edits to finish downloading');
			}
			const op = {version: 1, room: this.manifest.room, id: randomUUID(),
				author: this.author, name: String(name || 'Editor').slice(0, 80),
				clock: ++this.clock, parents, patch};
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
		const targetStat = await fs.lstat(this.filename);
		if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.size > maxFile) throw new Error('Unsafe or oversized diagram file');
		const current = await fs.readFile(this.filename, 'utf8');
		if (current === xml) return true;
		const hashOf = text => createHash('sha256').update(text).digest('hex');
		const currentHash = hashOf(current);
		if (currentHash !== this.manifest.originalHash)
		{
			try { await this.readJson('snapshot-' + currentHash + '.json', 1024 * 1024); }
			catch (e)
			{
				throw new Error('The .drawio file changed outside ShareMap, or its sync records have not downloaded yet. Preserve that copy and wait for OneDrive before retrying.');
			}
		}
		await this.immutable('snapshot-' + hashOf(xml) + '.json', {heads}).catch(e => { if (e.code !== 'EEXIST') throw e; });
		// The .drawio file is a materialized view. Concurrent OneDrive versions
		// are harmless to the authoritative immutable journal, which is replayed
		// on every join. Never use this file as an operation source after joining.
		const temp = path.join(path.dirname(this.filename), '.sharemap-' + randomUUID() + '.tmp');
		const handle = await fs.open(temp, 'wx');
		try { await handle.writeFile(xml, 'utf8'); await handle.sync(); }
		finally { await handle.close(); }
		try { await fs.rename(temp, this.filename); }
		finally { await fs.unlink(temp).catch(() => {}); }
		return true;
	}

	async shareLink(value)
	{
		if (value == null)
		{
			const names = (await fs.readdir(this.directory)).filter(name => /^link-[a-f0-9]{64}\.json$/.test(name)).sort();
			return names.length ? (await this.readJson(names[names.length - 1], 8192)).url : '';
		}
		const link = new URL(value);
		if (link.protocol !== 'https:' || link.username || link.password ||
			!(/^[a-z0-9-]+\.sharepoint\.com$/i.test(link.hostname)))
		{
			throw new Error('Use an HTTPS SharePoint folder link');
		}
		// Each link gets an immutable, content-addressed file. Avoid two people
		// concurrently updating a shared settings file.
		const hash = createHash('sha256').update(value).digest('hex');
		await this.immutable('link-' + hash + '.json', {url: value}).catch(e => { if (e.code !== 'EEXIST') throw e; });
		return link.href;
	}

	async activity(name, page, selection)
	{
		const value = {version: 1, room: this.manifest.room, author: this.author,
			name: String(name || 'Editor').slice(0, 80), updated: Date.now(),
			page: String(page || '').slice(0, 200),
			selection: Array.isArray(selection) ? selection.filter(id => typeof id === 'string').slice(0, 30).map(id => id.slice(0, 200)) : []};
		const target = await this.safePath('presence-' + this.author + '.json');
		const temp = await this.safePath('presence-' + this.author + '.tmp');
		await fs.writeFile(temp, JSON.stringify(value), {flag: 'wx'});
		try { await fs.rename(temp, target); }
		finally { await fs.unlink(temp).catch(() => {}); }
		const names = (await fs.readdir(this.directory)).filter(name => /^presence-[a-f0-9-]{36}\.json$/.test(name)).slice(0, 1000);
		const active = [];
		for (const name of names)
		{
			try
			{
				const peer = await this.readJson(name, 16384);
				if (peer.room === this.manifest.room && core.validId(peer.author) &&
					typeof peer.name === 'string' && peer.name.length <= 80 &&
					Number.isSafeInteger(peer.updated) && Math.abs(Date.now() - peer.updated) < 90000 &&
					Array.isArray(peer.selection) && peer.selection.length <= 30 && peer.selection.every(id => typeof id === 'string')) active.push(peer);
			}
			catch { /* A partially downloaded heartbeat must not stop durable saves. */ }
		}
		return active;
	}

	async leave()
	{
		const target = await this.safePath('presence-' + this.author + '.json');
		await fs.unlink(target).catch(e => { if (e.code !== 'ENOENT') throw e; });
	}
}

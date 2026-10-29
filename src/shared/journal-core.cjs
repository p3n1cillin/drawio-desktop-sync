/* Shared by the isolated desktop process and the editor. No network transport. */
(function(root)
{
	'use strict';
	const uuid = /^[a-f0-9-]{36}$/;
	const maxBytes = 4 * 1024 * 1024;
	function validId(value)
	{
		return typeof value === 'string' && uuid.test(value);
	}
	function validate(op, room)
	{
		if (!op || op.version !== 1 || op.room !== room || !validId(op.id) ||
			!validId(op.author) || !Number.isSafeInteger(op.clock) || op.clock < 1 ||
			!Array.isArray(op.parents) || op.parents.length > 10000 ||
			!op.parents.every(validId) || op.parents.includes(op.id) ||
			!op.patch || typeof op.patch !== 'object' || Array.isArray(op.patch) ||
			new TextEncoder().encode(JSON.stringify(op)).byteLength > maxBytes)
		{
			throw new Error('Invalid shared edit record');
		}
		return op;
	}
	function compare(a, b)
	{
		return a.clock - b.clock || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
	}
	function order(records, room)
	{
		const byId = new Map();
		for (const op of records)
		{
			validate(op, room);
			if (byId.has(op.id) && JSON.stringify(byId.get(op.id)) !== JSON.stringify(op))
			{
				throw new Error('Conflicting copies of a shared edit');
			}
			byId.set(op.id, op);
		}
		const ready = [];
		const applied = new Set();
		// A strict Lamport order is also causal. Missing dependencies and their
		// descendants wait for the server; they must never be partially applied.
		for (const op of [...byId.values()].sort(compare))
		{
			if (op.parents.every(id => applied.has(id) && byId.get(id).clock < op.clock))
			{
				ready.push(op);
				applied.add(op.id);
			}
		}
		const heads = new Set(applied);
		for (const op of ready) for (const id of op.parents) heads.delete(id);
		const index = new Map(ready.map(op => [op.id, op]));
		return {ready, heads: [...heads].sort(), pending: byId.size - ready.length, index};
	}
	// The server assigns increasing clocks, so new edits normally sort after the
	// whole journal. Appends them in place instead of re-sorting every record;
	// returns null (nothing changed) when a full order() is required.
	function extend(ordered, records, room)
	{
		if (!ordered || ordered.pending || !ordered.index) return null;
		const added = new Map();
		let last = ordered.ready[ordered.ready.length - 1];
		const sorted = [...records].sort(compare);
		for (const op of sorted)
		{
			validate(op, room);
			const known = ordered.index.get(op.id) || added.get(op.id);
			if (known && JSON.stringify(known) !== JSON.stringify(op)) throw new Error('Conflicting copies of a shared edit');
			if (known) continue;
			const parentOf = id => ordered.index.get(id) || added.get(id);
			if ((last && compare(op, last) <= 0) || !op.parents.every(id => parentOf(id) && parentOf(id).clock < op.clock)) return null;
			added.set(op.id, op);
			last = op;
		}
		const heads = new Set(ordered.heads);
		for (const op of added.values())
		{
			ordered.ready.push(op);
			ordered.index.set(op.id, op);
			for (const id of op.parents) heads.delete(id);
			heads.add(op.id);
		}
		ordered.heads = [...heads].sort();
		return ordered;
	}
	const api = {validate, order, extend, compare, validId, maxBytes};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	else root.ShareMapJournal = api;
})(globalThis);

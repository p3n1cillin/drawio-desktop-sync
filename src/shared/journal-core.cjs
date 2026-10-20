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
			JSON.stringify(op).length > maxBytes)
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
		// descendants wait for OneDrive; they must never be partially applied.
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
		return {ready, heads: [...heads].sort(), pending: byId.size - ready.length};
	}
	const api = {validate, order, compare, validId, maxBytes};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	else root.ShareMapJournal = api;
})(globalThis);

// Conflict metadata contains references, not duplicate copies of diagram values.
(function(root)
{
	'use strict';
	function fields(value, prefix = [], result = [])
	{
		if (prefix.length > 32) return result;
		if (value && typeof value === 'object' && !Array.isArray(value))
		{
			for (const key of Object.keys(value))
			{
				// Inserts/removals are additive lists, not competing property values.
				if (['i', 'r'].includes(key) && (!prefix.length || prefix.at(-1) === 'cells')) continue;
				if (!['__proto__', 'constructor', 'prototype'].includes(key)) fields(value[key], [...prefix, key], result);
			}
		}
		else result.push({path: prefix, key: JSON.stringify(prefix), value: JSON.stringify(value)});
		return result;
	}
	function detect(records, parents, patch, author)
	{
		const byId = new Map(records.map(op => [op.id, op]));
		const known = new Set();
		const stack = [...parents];
		while (stack.length)
		{
			const id = stack.pop();
			if (!known.has(id)) { known.add(id); stack.push(...(byId.get(id)?.parents || [])); }
		}
		const incoming = new Map(fields(patch).map(field => [field.key, field]));
		const found = new Map();
		for (const op of records)
		{
			if (known.has(op.id) || op.author === author) continue;
			for (const field of fields(op.patch))
			{
				const next = incoming.get(field.key);
				if (next && next.value !== field.value) found.set(field.key, {with: op.id, path: field.path});
			}
		}
		return [...found.values()].slice(0, 30);
	}
	function valueAt(object, keys)
	{
		for (const key of keys)
		{
			if (!object || !Object.prototype.hasOwnProperty.call(object, key)) return undefined;
			object = object[key];
		}
		return object;
	}
	function singleField(keys, value)
	{
		const patch = Object.create(null);
		let node = patch;
		for (const key of keys.slice(0, -1)) node = node[key] = Object.create(null);
		node[keys.at(-1)] = value;
		return patch;
	}
	const api = {detect, valueAt, singleField};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	else root.ShareMapConflicts = api;
})(globalThis);

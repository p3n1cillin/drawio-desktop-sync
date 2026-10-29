// Describes journal edits for the Show Changes pane, like the change list in
// Office co-authoring. Reads patches only; diagrams are never replayed for this.
(function(root)
{
	'use strict';
	const entities = {amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' '};
	const maxEntries = 2000;
	function decode(text)
	{
		return String(text).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity) =>
		{
			if (entity[0] !== '#') return entities[entity.toLowerCase()] ?? match;
			const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
		});
	}
	function plain(html)
	{
		return decode(String(html ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim().slice(0, 200);
	}
	function labelOf(json)
	{
		if (typeof json.xmlValue === 'string')
		{
			const match = /\slabel="([^"]*)"/.exec(json.xmlValue);
			return match ? plain(decode(match[1])) : '';
		}
		return typeof json.value === 'string' || typeof json.value === 'number' ? plain(json.value) : '';
	}
	function quote(text)
	{
		return '"' + (text.length > 60 ? text.slice(0, 57) + '…' : text) + '"';
	}
	function createState(labels = {}, pages = {})
	{
		return {labels: Object.assign(Object.create(null), labels), pages: Object.assign(Object.create(null), pages), entries: [], count: 0, last: null};
	}
	function apply(state, ops, times = {})
	{
		for (const op of ops)
		{
			const time = Number.isSafeInteger(op.time) ? op.time : times[op.id] ?? null;
			const add = (page, cell, kind, text) => state.entries.push({id: op.id + ':' + state.entries.length, op: op.id,
				author: String(op.name || 'Editor'), email: op.email || '', time, page, pageName: page ? state.pages[page] || '' : '', cell, kind, text});
			const patch = op.patch || {};
			for (const page of Array.isArray(patch.i) ? patch.i : [])
			{
				if (!page || typeof page.id !== 'string') continue;
				const name = decode((/\bname="([^"]*)"/.exec(page.data || '') || [])[1] || '') || 'Page';
				state.pages[page.id] = name;
				add(page.id, null, 'page-add', 'Added page ' + quote(name));
			}
			for (const id of Array.isArray(patch.r) ? patch.r : [])
			{
				add(id, null, 'page-delete', 'Deleted page ' + quote(state.pages[id] || 'Page'));
			}
			for (const [page, diff] of Object.entries(patch.u && typeof patch.u === 'object' ? patch.u : {}))
			{
				if (!diff || typeof diff !== 'object') continue;
				if (typeof diff.name === 'string')
				{
					add(page, null, 'page-rename', 'Renamed page ' + quote(state.pages[page] || 'Page') + ' to ' + quote(diff.name));
					state.pages[page] = diff.name;
				}
				const cells = diff.cells && typeof diff.cells === 'object' ? diff.cells : {};
				for (const json of Array.isArray(cells.i) ? cells.i : [])
				{
					if (!json || typeof json.id !== 'string') continue;
					const label = labelOf(json);
					state.labels[page + '\n' + json.id] = label;
					add(page, json.id, 'add', (json.edge ? 'Added connector' : 'Added shape') + (label ? ' ' + quote(label) : ''));
				}
				for (const [id, change] of Object.entries(cells.u && typeof cells.u === 'object' ? cells.u : {}))
				{
					if (!change || typeof change !== 'object') continue;
					const key = page + '\n' + id;
					const before = state.labels[key] ?? '';
					const subject = before ? quote(before) : 'a shape';
					const parts = [];
					if ('value' in change || 'xmlValue' in change)
					{
						const after = labelOf(change);
						state.labels[key] = after;
						if (after !== before) parts.push(['text', before ? 'Changed text from ' + quote(before) + ' to ' + quote(after) : 'Set text to ' + quote(after)]);
						else parts.push(['data', 'Edited data of ' + subject]);
					}
					if ('style' in change) parts.push(['format', 'Changed formatting of ' + subject]);
					if ('geometry' in change) parts.push(['move', 'Moved or resized ' + subject]);
					if ('source' in change || 'target' in change) parts.push(['connect', 'Reconnected ' + subject]);
					if ('parent' in change) parts.push(['move', 'Moved ' + subject + ' into another container']);
					if ('visible' in change || 'collapsed' in change) parts.push(['format', 'Changed visibility of ' + subject]);
					if (!parts.length && 'previous' in change) parts.push(['order', 'Reordered ' + subject]);
					if (parts.length) add(page, id, parts[0][0], parts.map(part => part[1]).join('; '));
				}
				for (const id of Array.isArray(cells.r) ? cells.r : [])
				{
					const key = page + '\n' + id;
					const label = state.labels[key];
					delete state.labels[key];
					add(page, id, 'delete', 'Deleted ' + (label ? quote(label) : 'a shape'));
				}
			}
			if (patch.f && typeof patch.f === 'object' && 'vars' in patch.f) add(null, null, 'document', 'Changed document properties');
			state.count++;
			state.last = op.id;
		}
		if (state.entries.length > maxEntries) state.entries.splice(0, state.entries.length - maxEntries);
		return state;
	}
	const api = {createState, apply, labelOf, plain};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	else root.ShareMapChanges = api;
})(globalThis);

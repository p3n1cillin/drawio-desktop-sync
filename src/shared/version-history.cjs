// Versions group bursts of journal edits, like AutoSave versions in Office. They
// reference journal positions only; diagrams are replayed when a version is opened.
(function(root)
{
	'use strict';
	const idle = 5 * 60 * 1000;
	const span = 30 * 60 * 1000;
	function timeOf(op, times)
	{
		const value = Number.isSafeInteger(op.time) ? op.time : times && times[op.id];
		return Number.isSafeInteger(value) && value > 0 ? value : null;
	}
	function group(ready, times = {}, created = null)
	{
		const versions = [];
		let last = Number.isSafeInteger(created) && created > 0 ? created : ready.length ? timeOf(ready[0], times) : null;
		if (last != null) versions.push({index: -1, start: last, end: last, names: [], edits: 0});
		let current = null;
		ready.forEach((op, index) =>
		{
			const time = timeOf(op, times) ?? last;
			if (!current || (time != null && current.end != null && (time - current.end > idle || time - current.start > span)))
			{
				current = {index, start: time, end: time, names: [], edits: 0};
				versions.push(current);
			}
			current.index = index;
			current.edits++;
			if (time != null)
			{
				current.start = current.start ?? time;
				current.end = Math.max(current.end ?? time, time);
				last = time;
			}
			const name = String(op.name || 'Editor');
			if (!current.names.includes(name)) current.names.push(name);
		});
		return versions.filter(version => version.end != null);
	}
	const api = {group, idle, span};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	else root.ShareMapVersions = api;
})(globalThis);

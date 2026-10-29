/* Loaded locally into each editor after the desktop bootstrap. */
Draw.loadPlugin(function(ui)
{
	'use strict';
	if (ui.sharedFolder) return;
	const core = window.ShareMapJournal;
	const conflictCore = window.ShareMapConflicts;
	const versionCore = window.ShareMapVersions;
	const graph = ui.editor.graph;
	let session = null;
	let probing = null;
	let probeTask = null;
	let probeRetryAt = 0;
	let timer = null;
	const bar = document.createElement('div');
	bar.style.cssText = 'position:fixed;top:7px;right:150px;z-index:4;display:flex;align-items:center;gap:10px;padding:3px 6px;color:light-dark(#222,#eee);font:12px Arial,sans-serif;max-width:calc(100vw - 410px)';
	const status = document.createElement('span');
	status.textContent = 'Open a shared diagram to collaborate';
	status.style.cssText = 'max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
	bar.appendChild(status);
	const people = document.createElement('div');
	people.style.cssText = 'display:flex;gap:3px';
	bar.appendChild(people);
	let highlights = [];
	let labels = [];
	const pointers = new Map();
	let pointer = null;
	// Comments, Show Changes and other panels follow the session through these events.
	const listeners = new Set();
	function emit(type, s)
	{
		for (const listener of listeners)
		{
			try { listener(type, s); }
			catch (error) { console.error('Shared diagram listener failed', error); }
		}
	}
	function displayName(s)
	{
		return localStorage.getItem('.sharemapName') || s.name || '';
	}
	function colorOf(peer)
	{
		return ['#2b78d0', '#9854c6', '#bb6332', '#16836a', '#c23985', '#567c26', '#a35e1b', '#5369be'][parseInt((peer.client || peer.author).replace(/-/g, '').slice(0, 4), 16) % 8];
	}
	// Pointers move on their own layer so presence boxes are not rebuilt for every mouse move.
	function showPointers(peers, s)
	{
		const seen = new Set();
		const view = graph.view;
		if (graph.container && view && ui.currentPage)
		{
			for (const peer of peers)
			{
				const isYou = peer.author === s.author || (peer.client && peer.client === s.client);
				if (isYou || !peer.pointer || peer.page !== ui.currentPage.getId() || Date.now() - peer.updated > 15000) continue;
				seen.add(peer.author);
				let node = pointers.get(peer.author);
				if (!node)
				{
					node = document.createElement('div');
					node.className = 'geSyncPointer';
					node.style.cssText = 'position:absolute;left:0;top:0;z-index:3;pointer-events:none;transition:transform 120ms linear;will-change:transform';
					const color = colorOf(peer);
					node.innerHTML = '<svg width="16" height="20" viewBox="0 0 16 20" style="display:block"><path d="M1 1 L1 16 L5 12 L8 19 L11 18 L8 11 L14 11 Z" fill="' + color + '" stroke="#fff" stroke-width="1.2"/></svg>';
					const tag = document.createElement('div');
					tag.style.cssText = 'margin:-4px 0 0 12px;padding:1px 5px;border-radius:3px;color:#fff;font:11px Arial;white-space:nowrap;background:' + color;
					node.appendChild(tag);
					graph.container.appendChild(node);
					pointers.set(peer.author, node);
				}
				node.lastChild.textContent = peer.name;
				node.style.transform = 'translate(' + Math.round((peer.pointer.x + view.translate.x) * view.scale) + 'px,' + Math.round((peer.pointer.y + view.translate.y) * view.scale) + 'px)';
			}
		}
		for (const [author, node] of pointers) if (!seen.has(author)) { node.remove(); pointers.delete(author); }
	}
	const editingNote = document.createElement('span');
	editingNote.className = 'geSyncEditingNote';
	editingNote.style.cssText = 'max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d89035';
	bar.appendChild(editingNote);
	function showPeople(peers, s)
	{
		showPointers(peers, s);
		const key = JSON.stringify([s.modelRevision, ui.currentPage?.getId(), graph.view?.scale, graph.view?.translate,
			graph.getSelectionCells().map(cell => cell.id), peers.map(peer => [peer.author, peer.name, peer.page, peer.selection, peer.editing, peer.editingCell])]);
		if (s.peopleKey === key) return;
		s.peopleKey = key;
		for (const highlight of highlights) highlight.destroy();
		for (const label of labels) label.remove();
		highlights = [];
		labels = [];
		editingNote.textContent = '';
		people.replaceChildren();
		for (const peer of peers.slice(0, 6))
		{
			const isYou = peer.author === s.author || (peer.client && peer.client === s.client);
			const color = colorOf(peer);
			const avatar = document.createElement('span');
			avatar.className = 'geSyncAvatar';
			const words = peer.name.trim().split(/\s+/);
			avatar.textContent = (words.length > 1 ? words[0][0] + words.at(-1)[0] : peer.name.slice(0, 2)).toUpperCase();
			avatar.title = peer.name + (peer.email ? ' <' + peer.email + '>' : '') + (isYou ? ' (you)' : peer.role === 'view' ? ' · viewing (view only)' :
				peer.editing ? ' · editing an object' : peer.selection.length ? ' · selecting an object' : ' · viewing this diagram');
			if (!isYou)
			{
				avatar.style.cursor = 'pointer';
				avatar.setAttribute('role', 'button');
				avatar.tabIndex = 0;
				const follow = () =>
				{
					const page = ui.pages?.find(page => page.getId() === peer.page);
					if (page && page !== ui.currentPage) ui.selectPage(page);
					const cell = graph.model.getCell(peer.editingCell || peer.selection[0]);
					if (cell) { graph.setSelectionCell(cell); graph.scrollCellToVisible(cell); }
				};
				avatar.addEventListener('click', follow);
				avatar.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); follow(); } });
			}
			avatar.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;border-radius:50%;width:25px;height:25px;color:white;background:' + color + ';font-size:10px';
			people.appendChild(avatar);
			if (!isYou && ui.currentPage && peer.page === ui.currentPage.getId())
			{
				if (peer.editing && graph.getSelectionCells().some(cell => cell.id === peer.editingCell || peer.selection.includes(cell.id))) editingNote.textContent = peer.name + ' is editing this object';
				for (const id of peer.selection)
				{
					const cell = graph.model.getCell(id);
					const state = cell && graph.view.getState(cell);
					if (state)
					{
						const highlight = new mxCellHighlight(graph, color, 2, true);
						highlight.highlight(state);
						highlights.push(highlight);
						if (graph.container)
						{
							const label = document.createElement('div');
							label.className = 'geSyncPresenceLabel';
							label.textContent = peer.name + (peer.editing ? ' · editing' : '');
							label.style.cssText = 'position:absolute;z-index:3;pointer-events:none;padding:2px 5px;border-radius:3px;color:#fff;font:11px Arial;white-space:nowrap;background:' + color + ';left:' + Math.max(0, state.x) + 'px;top:' + Math.max(0, state.y - 18) + 'px';
							graph.container.appendChild(label);
							labels.push(label);
						}
					}
				}
			}
		}
	}
	function button(label, action, parent = bar)
	{
		const result = document.createElement('button');
		result.textContent = label;
		result.className = 'geBtn';
		result.style.margin = '0';
		result.addEventListener('click', () => Promise.resolve().then(action).catch(showError));
		parent.appendChild(result);
		return result;
	}
	function showError(error)
	{
		const message = error && error.message || String(error);
		status.textContent = 'Needs attention';
		status.title = message;
		ui.handleError({message});
	}
	function updatePeople(s, peers)
	{
		s.lastPeers = peers;
		s.remotePeers = peers.filter(peer => peer.author !== s.author && peer.client !== s.client).length;
		showPeople(peers, s);
	}
	async function updateActivity(s)
	{
		if (!active(s) || s.activityTask) return;
		const selection = graph.getSelectionCells().map(cell => cell.id);
		const editing = graph.isEditing() || !!graph.mouseDown;
		const cell = graph.cellEditor?.editingCell;
		const state = {page: ui.currentPage?.getId(), selection, editing, editingCell: cell?.id || (graph.mouseDown ? selection[0] : '') || '', pointer};
		const signature = JSON.stringify(state);
		const elapsed = Date.now() - (s.lastActivity || 0);
		if (signature === s.activitySignature && elapsed < 10000) return;
		if (elapsed < 250)
		{
			// Sends the latest state once the throttle window ends instead of dropping it.
			if (!s.activityTimer) s.activityTimer = setTimeout(() => { s.activityTimer = null; updateActivity(s); }, 250 - elapsed);
			return;
		}
		s.lastActivity = Date.now();
		s.activityTask = true;
		try
		{
			const peers = await call('activity', {...state, name: displayName(s)}, s);
			if (active(s)) { s.activitySignature = signature; s.presenceError = null; updatePeople(s, peers); }
		}
		catch (error) { s.presenceError = error; }
		finally { s.activityTask = false; }
	}
	const reviewButton = button('Review changes', reviewConflicts);
	reviewButton.style.display = 'none';
	function collectConflicts(s, op)
	{
		if (!Array.isArray(op.conflicts)) return;
		if (!s.conflicts)
		{
			s.conflicts = new Map();
			try { s.reviewed = new Set(JSON.parse(localStorage.getItem('.sharemapReviewed.' + s.manifest.room) || '[]')); }
			catch { s.reviewed = new Set(); }
		}
		for (const [index, overlap] of op.conflicts.entries())
		{
			const key = op.id + ':' + index;
			if (!s.reviewed.has(key)) s.conflicts.set(key, {key, op, ...overlap});
		}
		reviewButton.textContent = 'Review changes (' + s.conflicts.size + ')';
		reviewButton.style.display = s.conflicts.size ? '' : 'none';
	}
	async function resolveConflict(key, earlier)
	{
		const s = session;
		const item = s?.conflicts?.get(key);
		if (!item) return;
		if (earlier)
		{
			const previous = s.records.get(item.with);
			if (!previous) throw new Error('The earlier edit is not available yet');
			graph.stopEditing();
			await cycle(s);
			if (!active(s) || s.error) throw s.error || new Error('The document changed');
			const value = conflictCore.valueAt(previous.patch, item.path);
			if (value === undefined) throw new Error('The earlier value is not available for this property');
			s.file.patch([conflictCore.singleField(item.path, value)], null, false, false, true);
			s.file.setModified(true);
			await cycle(s);
			if (s.error) throw s.error;
		}
		s.reviewed.add(key);
		s.conflicts.delete(key);
		localStorage.setItem('.sharemapReviewed.' + s.manifest.room, JSON.stringify([...s.reviewed].slice(-200)));
		reviewButton.textContent = 'Review changes (' + s.conflicts.size + ')';
		reviewButton.style.display = s.conflicts.size ? '' : 'none';
	}
	function reviewConflicts()
	{
		const s = session;
		const div = document.createElement('div');
		div.style.cssText = 'padding:20px;font:14px Arial;line-height:1.5;max-height:360px;overflow:auto';
		const title = document.createElement('h2'); title.textContent = 'Review overlapping changes'; div.appendChild(title);
		for (const item of [...(s?.conflicts?.values() || [])].slice(0, 10))
		{
			const previous = s.records.get(item.with);
			const text = document.createElement('p');
			const field = {value: 'Text', style: 'Formatting', x: 'Horizontal position', y: 'Vertical position', width: 'Width', height: 'Height'}[item.path.at(-1)] || 'The same property';
			text.textContent = field + ' was changed by ' + (previous?.name || 'another editor') + ' and ' + (item.op.name || 'another editor') + ' before their changes reached each other. Both edits are saved.';
			div.appendChild(text);
			if (['value', 'label'].includes(item.path.at(-1)))
			{
				for (const [label, op] of [['Earlier', previous], ['Latest', item.op]])
				{
					const preview = document.createElement('p');
					preview.textContent = label + ': ' + String(conflictCore.valueAt(op?.patch, item.path) ?? '').slice(0, 1000);
					preview.style.cssText = 'white-space:pre-wrap;padding:8px;border:1px solid #8885;border-radius:4px';
					div.appendChild(preview);
				}
			}
			button('Keep current value', async () => { await resolveConflict(item.key, false); ui.hideDialog(); }, div);
			button('Use earlier value', async () => { await resolveConflict(item.key, true); ui.hideDialog(); }, div);
		}
		button('Close', () => ui.hideDialog(), div);
		ui.showDialog(div, 590, 420, true, true);
	}
	function call(action, values = {}, target = session)
	{
		return electron.sharedFolder(Object.assign({action, id: target && target.id}, values));
	}
	function pages()
	{
		// Serialization flushes the current page/view state before cloning.
		ui.getFileData(true);
		return ui.clonePages(ui.pages);
	}
	function vars()
	{
		return ui.fileNode && ui.fileNode.getAttribute('vars');
	}
	function delta(before, after, beforeVars, afterVars)
	{
		const patch = ui.diffPages(before, after);
		if (beforeVars !== afterVars) patch.f = {vars: afterVars};
		return patch;
	}
	function capture(s)
	{
		const current = pages();
		return {pages: current, vars: vars(), patch: delta(s.baseline, current, s.vars, vars())};
	}
	function dirty(s)
	{
		if (s.role === 'view') return false;
		if (!s.pendingPublish && s.file.isModified && !s.file.isModified()) return false;
		return !mxUtils.isEmptyObject(capture(s).patch);
	}
	function active(s)
	{
		return session === s && ui.getCurrentFile() === s.file;
	}
	function savedStatus(s, pending)
	{
		const peers = s.remotePeers || 0;
		const others = peers ? ' · ' + (peers + 1) + ' people here' : '';
		status.textContent = pending ? 'Downloading changes…' : s.role === 'view' ? 'View only · Up to date' + others :
			s.paused ? 'AutoSave off' : 'Saved to server' + (others || ' · Connected');
	}
	async function publish(s)
	{
		if (!active(s) || s.role === 'view') return;
		if (!s.pendingPublish && s.file.isModified && !s.file.isModified()) return;
		const change = s.pendingPublish || capture(s);
		if (!mxUtils.isEmptyObject(change.patch))
		{
			s.pendingPublish = change;
			change.operationId = change.operationId || window.crypto.randomUUID();
			status.textContent = 'Saving to server…';
			const op = await call('append', {patch: change.patch, parents: s.heads,
				operationId: change.operationId, name: displayName(s)}, s);
			const wasCurrent = upToDate(s, s.ordered);
			addRecords(s, [op]);
			// The published pages are exactly the journal state when this edit
			// lands last, so nothing needs to be replayed.
			if (wasCurrent && s.ordered.ready.at(-1)?.id === op.id)
			{
				s.applied.push(op.id);
				s.confirmed = {pages: change.pages, vars: change.vars};
			}
			s.heads = s.ordered.heads;
			s.baseline = change.pages;
			s.vars = change.vars;
			s.pendingPublish = null;
			s.needsSnapshot = true;
		}
	}
	function addRecords(s, incoming)
	{
		const added = incoming.filter(op => !s.records.has(op.id));
		for (const op of added) { s.records.set(op.id, op); collectConflicts(s, op); }
		if (added.length || !s.ordered) s.ordered = (s.ordered && core.extend(s.ordered, added, s.manifest.room)) || core.order([...s.records.values()], s.manifest.room);
		return added.length > 0;
	}
	// Refreshed after every 25 new edits; idle cycles never serialize the map.
	function saveLaunchState(s)
	{
		const count = s.applied.length;
		if (count - (s.launchCount || 0) < 25 || s.savingLaunch || !s.confirmed) return;
		s.savingLaunch = true;
		const node = ui.getNodeForPages(s.confirmed.pages);
		if (s.confirmed.vars != null) node.setAttribute('vars', s.confirmed.vars);
		call('saveLaunchState', {count, last: s.applied[count - 1], xml: mxUtils.getXml(node)}, s)
			.then(() => { s.launchCount = count; }, () => {}).finally(() => { s.savingLaunch = false; });
	}
	function upToDate(s, ordered)
	{
		return !!ordered && s.applied.length === ordered.ready.length && s.applied.at(-1) === ordered.ready.at(-1)?.id;
	}
	// Replays only edits after the last applied one from a kept copy of that
	// state; the whole journal is replayed from the base only when history changed.
	function materialize(s, ordered)
	{
		const count = s.applied.length;
		const incremental = s.confirmed && count <= ordered.ready.length && ordered.ready[0]?.id === s.applied[0] && ordered.ready[count - 1]?.id === s.applied[count - 1];
		let merged = incremental ? ui.clonePages(s.confirmed.pages) : ui.getPagesForXml(s.manifest.base);
		let mergedVars = incremental ? s.confirmed.vars : mxUtils.parseXml(s.manifest.base).documentElement.getAttribute('vars');
		for (const op of incremental ? ordered.ready.slice(count) : ordered.ready)
		{
			merged = ui.patchPages(merged, op.patch, false, null, true, true, true);
			if (op.patch.f && Object.prototype.hasOwnProperty.call(op.patch.f, 'vars'))
			{
				mergedVars = op.patch.f.vars;
			}
		}
		s.confirmed = {pages: merged, vars: mergedVars};
		s.applied = ordered.ready.map(op => op.id);
		s.contributors = new Set(ordered.ready.map(op => op.author));
		// Read-only: patching starts from a clone of the confirmed pages.
		return s.confirmed;
	}
	async function cycle(s)
	{
		if (session !== s || ui.getCurrentFile() !== s.file || !s.initialized) return;
		if (s.running) return s.running;
		s.lastCycle = Date.now();
		s.running = (async () =>
		{
			try
			{
				// Do not interrupt a label edit or an active drag. Its final graph
				// transaction is captured on the next tick.
				if (graph.isEditing() || graph.mouseDown) return;
				await publish(s);
				if (!active(s)) return;
				const response = await call('scan', {}, s);
				if (session !== s || ui.getCurrentFile() !== s.file) return;
				addRecords(s, response.records);
				s.remoteChanged = false;
				if (active(s) && response.peers) updatePeople(s, response.peers);
				if (graph.isEditing() || graph.mouseDown) return;
				// Edits may have happened while disk IO was in flight.
				await publish(s);
				if (session !== s || ui.getCurrentFile() !== s.file || graph.isEditing() || graph.mouseDown || dirty(s)) return;
				const ordered = s.ordered;
				if (!upToDate(s, ordered))
				{
					const merged = materialize(s, ordered);
					const patch = delta(s.baseline, merged.pages, s.vars, merged.vars);
					if (!mxUtils.isEmptyObject(patch)) s.file.patch([patch], null, false, false, true);
					s.baseline = pages();
					s.vars = vars();
					s.heads = ordered.heads;
					s.needsSnapshot = true;
					emit('records', s);
				}
				const appliedKey = s.applied.length + ':' + s.applied.at(-1);
				// Persist a conventional .drawio view for exports and readers. Its
				// embedded heads prevent reopening an incomplete materialized view.
				let xml = s.snapshot;
				// Viewers never write the materialized view.
				if (s.needsSnapshot && s.role !== 'view')
				{
					const root = ui.getNodeForPages(s.baseline);
					root.setAttribute('sharemap-room', s.manifest.room);
					root.setAttribute('sharemap-heads', JSON.stringify(s.heads));
					xml = mxUtils.getXml(root);
					if (s.snapshot !== xml && await call('snapshot', {xml, heads: s.heads}, s)) s.snapshot = xml;
					if (s.snapshot === xml) s.needsSnapshot = false;
				}
				if (!active(s)) return;
				if (!dirty(s) && (s.file.isModified?.() || s.savedKey !== appliedKey || s.savedXml !== xml))
				{
					s.file.setModified(false);
					s.file.setShadowPages(ui.clonePages(s.baseline), s.vars);
					if (xml) s.file.setData(xml);
					ui.descriptorChanged();
					ui.editor.setStatus('');
					s.savedKey = appliedKey;
					s.savedXml = xml;
				}
				saveLaunchState(s);
				savedStatus(s, ordered.pending);
				status.title = ordered.ready.length + ' saved edits · ' + new Set([...(s.contributors || []), s.author]).size + ' contributors. ' +
					'Connected directly to ' + s.server + '. ' +
					'Same-property edits use deterministic last-writer order; all edits remain in the journal.';
				s.error = null;
				s.failures = 0;
			}
			catch (e)
			{
				s.error = e;
				s.retryAt = Date.now() + Math.min(10000, 1000 * (2 ** Math.min(4, s.failures || 0)));
				s.failures = (s.failures || 0) + 1;
				if (active(s))
				{
					status.textContent = 'Sync paused · Retry';
					status.title = e.message;
				}
				// Never clear modified state on failed IO. Clicking status retries.
			}
		})().finally(() => { s.running = null; });
		return s.running;
	}
	async function initialize(s)
	{
		if (s.initializing) return s.initializing;
		s.initializing = (async () =>
		{
		const response = await call('scan', {}, s);
		if (session !== s || ui.getCurrentFile() !== s.file) return;
		addRecords(s, response.records);
		const ordered = s.ordered;
		const required = JSON.parse(ui.fileNode.getAttribute('sharemap-heads') || '[]');
		const savedRoom = ui.fileNode.getAttribute('sharemap-room');
		if (savedRoom && savedRoom !== s.manifest.room) throw new Error('This copy belongs to a different shared diagram. Reopen it from its shared-diagram link.');
		const available = new Set(ordered.ready.map(op => op.id));
		if (!Array.isArray(required) || !required.every(id => available.has(id)) || ordered.pending)
		{
			throw new Error('Waiting for earlier server edits. Reconnect and retry.');
		}
		const cached = await call('launchState', {}, s).catch(() => null);
		if (session !== s || ui.getCurrentFile() !== s.file) return;
		if (cached?.count <= ordered.ready.length && ordered.ready[cached.count - 1]?.id === cached.last)
		{
			s.confirmed = {pages: ui.getPagesForXml(cached.xml), vars: mxUtils.parseXml(cached.xml).documentElement.getAttribute('vars')};
			s.applied = ordered.ready.slice(0, cached.count).map(op => op.id);
			s.launchCount = cached.count;
		}
		const merged = materialize(s, ordered);
		ui.fileNode.removeAttribute('sharemap-room');
		ui.fileNode.removeAttribute('sharemap-heads');
		const before = pages();
		const patch = delta(before, merged.pages, vars(), merged.vars);
		if (!mxUtils.isEmptyObject(patch)) s.file.patch([patch], null, false, false, true);
		s.baseline = pages();
		s.vars = vars();
		s.heads = ordered.heads;
		s.needsSnapshot = true;
		s.initialized = true;
		s.paused = localStorage.getItem(autoSaveKey(s)) === 'off';
		autoSave.style.display = s.role === 'view' ? 'none' : 'inline-block';
		autoSave.disabled = false;
		autoSave.textContent = 'AutoSave  ' + (s.paused ? 'Off' : 'On');
		autoSave.setAttribute('aria-pressed', String(!s.paused));
		s.file.setModified(false);
		ui.setGraphEnabled(s.file.isEditable() && s.role !== 'view');
		ui.updateActionStates?.();
		emit('session', s);
		await cycle(s);
		watch(s);
		})();
		try { await s.initializing; }
		finally { s.initializing = null; }
	}
	async function flush(s)
	{
		const check = () => { if (!active(s)) throw new Error('The document changed while saving. Reopen it to check the saved edits.'); };
		check();
		await cycle(s);
		check();
		for (let attempt = 0; attempt < 3 && s.initialized && !s.error && dirty(s); attempt++)
		{
			await cycle(s);
			check();
		}
		if (s.error || !s.initialized || dirty(s)) throw s.error || new Error('Edits are still being saved. Retry.');
	}
	async function versions(s)
	{
		graph.stopEditing();
		await cycle(s);
		if (!active(s)) throw new Error('The document changed. Reopen Version History.');
		if (s.error) throw s.error;
		let history = {};
		let historyError = null;
		try { history = await call('history', {}, s); }
		catch (error) { historyError = error; }
		const ready = (s.ordered || core.order([...s.records.values()], s.manifest.room)).ready;
		const groups = versionCore.group(ready, history.times, history.created);
		if (!groups.length) throw historyError && !/Endpoint not found/.test(historyError.message) ? historyError :
			new Error('Version history needs the updated collaboration server. Ask its administrator to update it.');
		// Replays forward from the last opened version; opening an older one starts again from the base.
		let replay = null;
		const xmlAt = index =>
		{
			if (index === s.applied.length - 1 && s.confirmed && s.applied[index] === ready[index]?.id) replay = {index, pages: ui.clonePages(s.confirmed.pages), vars: s.confirmed.vars};
			else if (!replay || index < replay.index) replay = {index: -1, pages: ui.getPagesForXml(s.manifest.base),
				vars: mxUtils.parseXml(s.manifest.base).documentElement.getAttribute('vars')};
			for (let next = replay.index + 1; next <= index; next++)
			{
				const patch = ready[next].patch;
				replay.pages = ui.patchPages(replay.pages, patch, false, null, true, true, true);
				if (patch.f && Object.prototype.hasOwnProperty.call(patch.f, 'vars')) replay.vars = patch.f.vars;
			}
			replay.index = index;
			const node = ui.getNodeForPages(replay.pages);
			if (replay.vars != null) node.setAttribute('vars', replay.vars);
			return mxUtils.getXml(node);
		};
		const revs = groups.map(version => ({id: String(version.index), modifiedDate: version.end, edits: version.edits,
			lastModifyingUserName: version.edits ? version.names.join(', ') : 'Shared diagram created',
			getXml: (success, error) => { try { success(xmlAt(version.index)); } catch (e) { error(e); } }}));
		revs.shareMap = true;
		return revs;
	}
	// A restore is published as a new edit, so every earlier version stays available.
	async function restoreVersion(s, xml)
	{
		graph.stopEditing();
		await cycle(s);
		if (!active(s) || s.error) throw s.error || new Error('The document changed while restoring. Retry.');
		const patch = delta(pages(), ui.getPagesForXml(xml), vars(), mxUtils.parseXml(xml).documentElement.getAttribute('vars'));
		if (!mxUtils.isEmptyObject(patch))
		{
			s.file.patch([patch], null, false, false, true);
			s.file.setModified(true);
			await cycle(s);
			if (s.error) throw s.error;
		}
		if (active(s)) status.textContent = 'Version restored · Saved to server';
	}
	// Push updates: the server holds this request until edits, comments or
	// presence change. Older servers without it keep the one-second poll.
	async function watch(s)
	{
		if (s.watching || s.watchUnsupported) return;
		s.watching = true;
		try
		{
			while (session === s && s.initialized)
			{
				try
				{
					const state = await call('watch', {cursor: s.watchCursor, epoch: s.watchEpoch, comments: s.commentVersion, presence: s.presenceVersion}, s);
					if (session !== s) return;
					s.watchHealthy = true;
					s.presenceVersion = state.presence;
					if (state.peers && active(s)) updatePeople(s, state.peers);
					if (state.comments !== s.commentVersion) { s.commentVersion = state.comments; emit('comments', s); }
					if (state.cursor !== s.watchCursor || state.epoch !== s.watchEpoch)
					{
						s.watchCursor = state.cursor;
						s.watchEpoch = state.epoch;
						s.remoteChanged = true;
						if (!s.paused && Date.now() >= (s.retryAt || 0)) cycle(s);
					}
				}
				catch (error)
				{
					s.watchHealthy = false;
					if (/Endpoint not found|Unknown collaboration action/.test(error.message)) { s.watchUnsupported = true; return; }
					await new Promise(resolve => setTimeout(resolve, 2000));
				}
			}
		}
		finally { s.watching = false; }
	}
	function endSession(text)
	{
		const s = session;
		session = null;
		reviewButton.style.display = 'none';
		showPeople([], {});
		autoSave.style.display = 'none';
		status.textContent = text;
		ui.updateActionStates?.();
		if (s) emit('closed', s);
	}
	async function open()
	{
		if (probeTask)
		{
			const pendingFile = probing;
			const current = ui.getCurrentFile();
			if (current && current.fileObject && /\.drawio$/i.test(current.fileObject.path) && current.isEditable())
			{
				current.shareMapGuard = true;
				current.clearAutosave();
				ui.setGraphEnabled(false);
			}
			try { await probeTask; }
			catch (e) { if (ui.getCurrentFile() === pendingFile) throw e; }
			if (ui.getCurrentFile() !== pendingFile || !session) return open();
			return session;
		}
		const file = ui.getCurrentFile();
		if (!file || !file.fileObject || !/\.drawio$/i.test(file.fileObject.path) || !file.isEditable())
		{
			if (session && (session.file !== file || !file.isEditable()))
			{
				await call('close', {}, session);
				endSession('Open a shared diagram to collaborate');
			}
			return;
		}
		if (session && session.file === file) return session;
		if (file.savingFile) throw new Error('Wait for the current save to finish, then retry.');
		probing = file;
		file.shareMapGuard = true;
		file.clearAutosave();
		ui.setGraphEnabled(false);
		probeTask = (async () =>
		{
			try
			{
				const info = await call('open', {path: file.fileObject.path}, null);
				if (file !== ui.getCurrentFile())
				{
					if (info) await call('close', {}, info);
					return;
				}
				if (session) await call('close', {}, session);
				endSession('Connecting to server…');
				if (info)
				{
					if (info.mapName) { file.fileObject.name = info.mapName; file.title = info.mapName; ui.descriptorChanged(); }
					session = Object.assign(info, {file, path: file.fileObject.path, records: new Map(), heads: [], applied: [], initialized: false});
					await initialize(session);
				}
				else
				{
					file.shareMapGuard = false;
					ui.setGraphEnabled(file.isEditable());
					autoSave.style.display = 'none';
					status.textContent = 'Open a shared diagram to collaborate';
				}
				return session;
			}
			finally
			{
				probeRetryAt = Date.now() + 5000;
				probing = null;
				probeTask = null;
			}
		})();
		return probeTask;
	}
	function editorDiagnostics(s)
	{
		return {initialized: s.initialized, paused: s.paused, running: !!s.running,
			editing: graph.isEditing(), mouseDown: !!graph.mouseDown,
			error: s.error && s.error.message, presenceError: s.presenceError && s.presenceError.message};
	}
	async function diagnostics()
	{
		const s = session;
		if (!s) throw new Error('Open a shared diagram first.');
		status.textContent = 'Checking sync…';
		const report = await call('diagnostics', {editor: editorDiagnostics(s)}, s);
		if (!active(s)) return;
		const div = document.createElement('div');
		div.style.cssText = 'padding:20px;font:13px Arial;line-height:1.5';
		const title = document.createElement('h2');
		title.textContent = 'Sync diagnostics';
		div.appendChild(title);
		const note = document.createElement('p');
		note.textContent = 'Compare the room and edit fingerprint on both PCs. Different fingerprints mean some edits have not reached both PCs. No diagram content is included.';
		div.appendChild(note);
		const text = document.createElement('textarea');
		text.readOnly = true;
		text.value = JSON.stringify(report, null, 2);
		text.style.cssText = 'box-sizing:border-box;width:100%;height:280px;font:12px monospace';
		div.appendChild(text);
		const controls = document.createElement('div');
		controls.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px';
		div.appendChild(controls);
		button('Copy diagnostics', async () =>
		{
			await call('diagnostics', {copy: true, editor: editorDiagnostics(s)}, s);
			status.textContent = 'Sync diagnostics copied';
		}, controls);
		button('Close', () => ui.hideDialog(), controls);
		ui.showDialog(div, 680, 460, true, true);
		savedStatus(s, false);
	}
	async function serverOpen(invite)
	{
		const info = await call('serverJoin', {invite}, null);
		ui.loadArgs({args: [info.path]});
	}
	function serverJoinDialog()
	{
		const div = document.createElement('div');
		div.style.cssText = 'padding:20px;font:14px Arial;line-height:1.5';
		const title = document.createElement('h2');
		title.textContent = 'Open shared diagram';
		div.appendChild(title);
		const note = document.createElement('p');
		note.textContent = 'Paste the shared-diagram link that was sent to you. The diagram opens from the collaboration server and reconnects automatically next time.';
		div.appendChild(note);
		const input = document.createElement('textarea');
		input.placeholder = 'drawio-sync://join/…';
		input.style.cssText = 'box-sizing:border-box;width:100%;height:90px';
		div.appendChild(input);
		button('Open', async () => { await serverOpen(input.value.trim()); ui.hideDialog(); }, div);
		button('Cancel', () => ui.hideDialog(), div);
		ui.showDialog(div, 520, 260, true, true);
	}
	function nameDialog()
	{
		const div = document.createElement('div');
		div.style.cssText = 'padding:20px;font:14px Arial';
		const label = document.createElement('label'); label.textContent = 'Your display name (leave blank to use your account name)'; div.appendChild(label);
		const input = document.createElement('input');
		input.value = localStorage.getItem('.sharemapName') || '';
		input.placeholder = session?.name || '';
		input.maxLength = 80;
		input.style.cssText = 'display:block;width:100%;box-sizing:border-box;padding:8px;margin:10px 0';
		label.appendChild(input);
		button('Save', () => { localStorage.setItem('.sharemapName', input.value.trim().slice(0, 80)); if (session) { session.lastActivity = 0; updateActivity(session); } ui.hideDialog(); }, div);
		button('Cancel', () => ui.hideDialog(), div);
		ui.showDialog(div, 380, 150, true, true);
	}
	async function serverCreate()
	{
		const file = ui.getCurrentFile();
		if (!file?.fileObject) throw new Error('Open or save the diagram first.');
		graph.stopEditing();
		ui.setGraphEnabled(false);
		try
		{
			const info = await call('serverCreate', {path: file.fileObject.path, xml: ui.getFileData(true)}, null);
			if (ui.getCurrentFile() !== file) throw new Error('The shared diagram was created on the server. Reopen it from Recent files after finishing this document.');
			file.setModified(false);
			ui.loadArgs({args: [info.path]});
		}
		finally { if (ui.getCurrentFile() === file) ui.setGraphEnabled(file.isEditable()); }
	}
	function element(tag, text, css, parent)
	{
		const node = document.createElement(tag);
		if (text) node.textContent = text;
		if (css) node.style.cssText = css;
		if (parent) parent.appendChild(node);
		return node;
	}
	// Office-style sharing: one link per permission, people with access, and owner controls.
	function serverAccess()
	{
		const s = session;
		const div = element('div', '', 'padding:20px;font:14px Arial;line-height:1.5');
		element('h2', 'Share "' + (s.mapName || 'diagram') + '"', 'margin-top:0', div);
		const row = element('div', '', 'display:flex;gap:8px;align-items:center', div);
		const kind = element('select', '', 'flex:1;padding:6px', row);
		for (const [value, text] of [['edit', 'People with the link can edit'], ['view', 'People with the link can view']])
		{
			if (value === 'edit' && s.role === 'view') continue;
			const option = element('option', text, '', kind);
			option.value = value;
		}
		const copy = button('Copy link', async () =>
		{
			await call('copyLink', {kind: kind.value}, s);
			status.textContent = (kind.value === 'view' ? 'View' : 'Edit') + ' link copied';
			ui.hideDialog();
		}, row);
		copy.className = 'geBtn gePrimaryBtn';
		element('p', 'Anyone with the link who can reach ' + new URL(s.server).host + ' can open it in drawio-desktop-sync (… → Open shared diagram). ' +
			'View links open the diagram read-only. Treat links like keys and share them only with people who should have access.', 'font-size:12px;opacity:.8', div);
		const people = element('div', '', 'max-height:140px;overflow:auto;border-top:1px solid #8884;padding-top:6px', div);
		element('div', 'People with access', 'font-weight:600', people);
		const list = element('div', 'Loading…', 'font-size:12px', people);
		call('people', {}, s).then(known =>
		{
			const here = new Set((s.lastPeers || []).map(peer => peer.email).filter(Boolean));
			list.textContent = known.length ? '' : 'Nobody with a work or school account has opened this diagram yet.';
			for (const person of known) element('div', person.name + ' <' + person.email + '>' + (here.has(person.email) ? ' · here now' : ''), '', list);
		}).catch(() => { list.textContent = 'Update the collaboration server to list people.'; });
		if (s.owner)
		{
			element('div', 'Stop sharing', 'font-weight:600;margin-top:10px', div);
			element('div', 'Disconnects everyone using the current link. Send a new link to people who should keep access.', 'font-size:12px;opacity:.8', div);
			const controls = element('div', '', 'display:flex;gap:8px;margin-top:4px', div);
			for (const [value, text] of [['edit', 'Stop edit links'], ['view', 'Stop view links']])
			{
				button(text, async () => { await call('rotateLink', {kind: value}, s); ui.hideDialog(); status.textContent = (value === 'view' ? 'View' : 'Edit') + ' links stopped'; }, controls);
			}
		}
		const close = element('div', '', 'display:flex;justify-content:flex-end;margin-top:12px', div);
		button('Close', () => ui.hideDialog(), close);
		ui.showDialog(div, 560, s.owner ? 430 : 350, true, true);
	}
	// The … menu lists actions in order; panels add their own before the settings items.
	const menuItems = [
		{label: 'Open shared diagram', action: () => serverJoinDialog()},
		{label: 'Share this diagram on the server', action: () => serverCreate(), when: () => !session},
		{label: 'Version history', action: () => ui.actions.get('revisionHistory').funct(), when: () => session?.initialized},
		{label: 'Your display name', action: () => nameDialog(), settings: true},
		{label: 'Create desktop shortcut', action: () => call('shortcut'), when: () => session, settings: true},
		{label: 'Sync diagnostics', action: () => diagnostics(), when: () => session, settings: true}];
	function addMenuItem(label, action, when)
	{
		menuItems.splice(menuItems.findIndex(item => item.settings), 0, {label, action, when});
	}

	function autoSaveKey(s) { return '.sharemapAutoSave.' + s.manifest.room + '.' + s.client; }
	const autoSave = button('AutoSave  On', () =>
	{
		if (!session) return;
		graph.stopEditing();
		const paused = !session.paused;
		localStorage.setItem(autoSaveKey(session), paused ? 'off' : 'on');
		session.paused = paused;
		autoSave.textContent = 'AutoSave  ' + (session.paused ? 'Off' : 'On');
		autoSave.setAttribute('aria-pressed', String(!session.paused));
		status.textContent = session.paused ? 'AutoSave off · Ctrl+S to save' : 'Saving…';
		if (!session.paused) return cycle(session);
	});
	window.addEventListener('drawio-preference-changed', event =>
	{
		const s = session;
		if (!s?.initialized || event.detail.key !== autoSaveKey(s)) return;
		s.paused = event.detail.value === 'off';
		autoSave.textContent = 'AutoSave  ' + (s.paused ? 'Off' : 'On');
		autoSave.setAttribute('aria-pressed', String(!s.paused));
		if (!s.paused) cycle(s);
	});
		autoSave.style.display = 'none';
	autoSave.style.cssText += ';border:1px solid #8886;border-radius:14px;padding:5px 10px;white-space:nowrap';
	autoSave.title = 'Automatically save your edits and merge changes from the server';
	bar.insertBefore(autoSave, status);
	const share = button('Share', async () => { if (session?.initialized) serverAccess(); else await serverCreate(); });
	share.style.cssText += ';background:#107c41;color:#fff;border:0;border-radius:5px;padding:6px 18px;font-weight:600';
	share.title = 'Share this diagram';
	function addBarButton(label, action, title)
	{
		const result = button(label, action);
		bar.insertBefore(result, share);
		result.title = title || label;
		result.style.cssText += ';display:none;border:1px solid #8886;border-radius:5px;padding:5px 10px;white-space:nowrap';
		return result;
	}
	button('⋯', () =>
	{
		const div = element('div', '', 'padding:20px;display:flex;flex-direction:column;gap:12px');
		const items = menuItems.filter(item => !item.when || item.when());
		for (const item of items) button(item.label, () => { ui.hideDialog(); return item.action(); }, div);
		ui.showDialog(div, 310, 40 + items.length * 42, true, true);
	}).title = 'More sharing options';
	status.style.cursor = 'pointer';
	status.addEventListener('click', () =>
	{
		if (session && session.initialized)
		{
			const s = session;
			cycle(s).then(() => { if (active(s) && s.error) showError(s.error); });
		}
		else if (session) initialize(session).catch(showError);
		else open().catch(showError);
	});
	document.body.appendChild(bar);

	const originalAutosave = LocalFile.prototype.isAutosave;
	LocalFile.prototype.isAutosave = function()
	{
		return !this.shareMapGuard && this !== probing && !(session && session.file === this) && originalAutosave.apply(this, arguments);
	};
	const originalSave = LocalFile.prototype.save;
	function saveOrdinary(file, args)
	{
		const values = Array.from(args);
		const success = values[1];
		values[1] = function()
		{
			// First save and Save As do not emit fileLoaded, so check now whether
			// the saved file is a shared map instead of waiting for a reopen.
			if (ui.getCurrentFile() === file) open().catch(showError);
			if (success) success.apply(this, arguments);
		};
		return originalSave.apply(file, values);
	}
	LocalFile.prototype.save = function(revision, success, error)
	{
		if (session && session.file === this)
		{
			if (this.fileObject.path !== session.path)
			{
				const s = session;
				const args = arguments;
				graph.stopEditing();
				flush(s).then(async () =>
				{
					await call('close', {}, s);
					if (!active(s)) throw new Error('The document changed while saving a copy. Retry.');
					endSession('Standalone copy · Share to collaborate');
					this.shareMapGuard = false;
					saveOrdinary(this, args);
				}).catch(e => { if (error) error(e); else showError(e); });
				return;
			}
			graph.stopEditing();
			const s = session;
			flush(s).then(() =>
			{
				if (success) success();
			}).catch(e => { if (error) error(e); else showError(e); });
			return;
		}
		if (this.shareMapGuard || this === probing) { if (error) error({message: 'Wait for the shared diagram to finish connecting to the server'}); return; }
		return saveOrdinary(this, arguments);
	};
	// File > Version History uses the editor's own revision dialog for the journal.
	const originalRevisionSupport = LocalFile.prototype.isRevisionHistorySupported;
	LocalFile.prototype.isRevisionHistorySupported = function()
	{
		return !!(session && session.file === this && session.initialized) || !!originalRevisionSupport?.apply(this, arguments);
	};
	const originalHistoryEnabled = ui.isRevisionHistoryEnabled;
	ui.isRevisionHistoryEnabled = function()
	{
		const file = this.getCurrentFile();
		return !!(session && session.file === file && session.initialized) || !!originalHistoryEnabled?.apply(this, arguments);
	};
	const originalRevisions = LocalFile.prototype.getRevisions;
	LocalFile.prototype.getRevisions = function(success, error)
	{
		if (!session || session.file !== this) return originalRevisions?.apply(this, arguments);
		const s = session;
		versions(s).then(revs => success(revs, xml =>
		{
			ui.hideDialog();
			restoreVersion(s, xml).catch(showError);
		}), error);
	};
	const BaseRevisionDialog = window.RevisionDialog;
	if (typeof BaseRevisionDialog === 'function')
	{
		// Lists who edited each version under its date, like Office version history.
		window.RevisionDialog = function(editorUi, revs)
		{
			BaseRevisionDialog.apply(this, arguments);
			if (!revs?.shareMap) return;
			const heading = this.container.querySelector('h3');
			if (heading) heading.textContent = 'Version History';
			this.container.querySelectorAll('tr').forEach((row, index) =>
			{
				const rev = revs[revs.length - 1 - index];
				if (!rev || !row.firstChild) return;
				const who = document.createElement('div');
				who.className = 'geSyncVersionAuthors';
				who.textContent = rev.lastModifyingUserName + (rev.edits ? ' · ' + rev.edits + (rev.edits === 1 ? ' edit' : ' edits') : '');
				who.style.cssText = 'opacity:.7;font-size:11px;white-space:normal';
				row.firstChild.appendChild(who);
			});
		};
		window.RevisionDialog.prototype = BaseRevisionDialog.prototype;
	}
	const originalChange = ui.handleFileChange;
	ui.handleFileChange = function(curr, prev, file)
	{
		if (session && session.file === file) { session.snapshot = null; session.needsSnapshot = true; return; }
		if (file === probing) return;
		return originalChange.apply(this, arguments);
	};
	// Synchronize must read the journal, never reinterpret a materialized
	// snapshot as another user's edits or run the normal stale-file merge.
	const originalSync = LocalFile.prototype.synchronizeFile;
	LocalFile.prototype.synchronizeFile = function(success, error)
	{
		if (session && session.file === this)
		{
			const s = session;
			cycle(s).then(() =>
			{
				if (!active(s)) throw new Error('The document changed while synchronizing. Retry.');
				if (s.error) throw s.error;
				if (success) success();
			}).catch(error || showError);
		}
		else return originalSync.apply(this, arguments);
	};
	// Every loaded document is checked; only server maps start a session.
	ui.editor.addListener('fileLoaded', () => open().catch(showError));
	timer = setInterval(() =>
	{
		if (session && session.file === ui.getCurrentFile())
		{
			if (session.initialized)
			{
				updateActivity(session);
				if (session.lastPeers) showPeople(session.lastPeers, session);
				// With push updates the poll is only a safety net.
				const interval = session.watchHealthy && !session.remoteChanged ? 5000 : 1000;
				if (!session.paused && Date.now() >= (session.retryAt || 0) && Date.now() - (session.lastCycle || 0) >= interval) cycle(session);
			}
			else if (!session.initialized) initialize(session).catch(e => { status.textContent = 'Connecting to server · Click for details'; status.title = e.message; });
		}
		else if (!probeTask && ui.getCurrentFile()?.shareMapGuard && Date.now() >= probeRetryAt)
		{
			open().catch(e => { status.textContent = 'Connecting to server · Click for details'; status.title = e.message; });
		}
	}, 500);
	window.addEventListener('unload', () => clearInterval(timer));
	let changeTimer;
	if (graph.model?.addListener) graph.model.addListener(mxEvent.CHANGE, () =>
	{
		const s = session;
		if (!s || !active(s) || !s.initialized) return;
		s.modelRevision = (s.modelRevision || 0) + 1;
		window.clearTimeout(changeTimer);
		changeTimer = window.setTimeout(() => { if (active(s) && !s.paused && Date.now() >= (s.retryAt || 0)) cycle(s); }, 150);
	});
	if (graph.container)
	{
		graph.container.addEventListener('pointermove', event =>
		{
			const s = session;
			if (!s?.initialized || !active(s)) return;
			const point = mxUtils.convertPoint(graph.container, event.clientX, event.clientY);
			pointer = {x: Math.round(point.x / graph.view.scale - graph.view.translate.x), y: Math.round(point.y / graph.view.scale - graph.view.translate.y)};
			updateActivity(s);
		}, {passive: true});
		graph.container.addEventListener('pointerleave', () => { pointer = null; if (session?.initialized) updateActivity(session); });
	}
	// Used by the collaboration panels, integration tests and diagnostics.
	ui.sharedFolder = {open, reviewConflicts, resolveConflict, cycle: () => session && cycle(session), getSession: () => session, diagnostics, serverOpen, serverCreate,
		versions: () => session && versions(session), restoreVersion: xml => session && restoreVersion(session, xml),
		call: (action, values) => call(action, values), on: listener => listeners.add(listener), active: s => active(s),
		displayName: () => session && displayName(session), addBarButton, addMenuItem, showError, joinDialog: serverJoinDialog};
	open().catch(showError);
});

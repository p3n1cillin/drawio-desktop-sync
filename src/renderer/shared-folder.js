/* Loaded locally into each editor after the desktop bootstrap. */
Draw.loadPlugin(function(ui)
{
	'use strict';
	if (ui.sharedFolder) return;
	const core = window.ShareMapJournal;
	const conflictCore = window.ShareMapConflicts;
	const graph = ui.editor.graph;
	let session = null;
	let probing = null;
	let probeTask = null;
	let probeRetryAt = 0;
	let timer = null;
	const bar = document.createElement('div');
	bar.style.cssText = 'position:fixed;top:7px;right:150px;z-index:4;display:flex;align-items:center;gap:10px;padding:3px 6px;color:light-dark(#222,#eee);font:12px Arial,sans-serif;max-width:calc(100vw - 410px)';
	const status = document.createElement('span');
	status.textContent = 'Open a shared map to collaborate';
	status.style.cssText = 'max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
	bar.appendChild(status);
	const people = document.createElement('div');
	people.style.cssText = 'display:flex;gap:3px';
	bar.appendChild(people);
	let highlights = [];
	let labels = [];
	const editingNote = document.createElement('span');
	editingNote.className = 'geSyncEditingNote';
	editingNote.style.cssText = 'max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d89035';
	bar.appendChild(editingNote);
	function showPeople(peers, s)
	{
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
			const color = ['#2b78d0', '#9854c6', '#bb6332', '#16836a', '#c23985', '#567c26', '#a35e1b', '#5369be'][parseInt((peer.client || peer.author).replace(/-/g, '').slice(0, 4), 16) % 8];
			const avatar = document.createElement('span');
			avatar.className = 'geSyncAvatar';
			avatar.textContent = peer.name.slice(0, 2).toUpperCase();
			avatar.title = peer.name + (isYou ? ' (you)' : peer.editing ? ' · editing an object' : peer.selection.length ? ' · selecting an object' : ' · viewing this map');
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
		const state = {page: ui.currentPage?.getId(), selection, editing, editingCell: cell?.id || (graph.mouseDown ? selection[0] : '') || ''};
		const signature = JSON.stringify(state);
		const elapsed = Date.now() - (s.lastActivity || 0);
		if (elapsed < 250 || (signature === s.activitySignature && elapsed < 10000)) return;
		s.lastActivity = Date.now();
		s.activityTask = true;
		try
		{
			const peers = await call('activity', {...state, name: localStorage.getItem('.sharemapName') || s.name}, s);
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
		status.textContent = pending ? 'Downloading changes…' : s.paused ? 'AutoSave off' :
			'Saved to server · ' + (peers ? (peers + 1) + ' editors seen' : 'Connected');
	}
	async function publish(s)
	{
		if (!active(s)) return;
		if (!s.pendingPublish && s.file.isModified && !s.file.isModified()) return;
		const change = s.pendingPublish || capture(s);
		if (!mxUtils.isEmptyObject(change.patch))
		{
			s.pendingPublish = change;
			if (s.transport === 'server' && !change.operationId) change.operationId = window.crypto.randomUUID();
			status.textContent = s.transport === 'server' ? 'Saving to server…' : 'Saving edits locally…';
			const op = await call('append', {patch: change.patch, parents: s.heads,
				operationId: change.operationId, name: localStorage.getItem('.sharemapName') || s.name || ''}, s);
			s.records.set(op.id, op);
			collectConflicts(s, op);
			s.ordered = core.order([...s.records.values()], s.manifest.room);
			s.heads = s.ordered.heads;
			s.baseline = change.pages;
			s.vars = change.vars;
			s.pendingPublish = null;
			s.needsSnapshot = true;
		}
	}
	function materialize(s, ordered)
	{
		const previous = s.applied || [];
		const tail = ordered.ready.slice(previous.length);
		const incremental = previous.length && previous.every((id, index) => ordered.ready[index]?.id === id) && !tail.some(op => op.author === s.author);
		let merged = incremental ? ui.clonePages(s.baseline) : ui.getPagesForXml(s.manifest.base);
		let mergedVars = incremental ? s.vars : mxUtils.parseXml(s.manifest.base).documentElement.getAttribute('vars');
		for (const op of incremental ? tail : ordered.ready)
		{
			merged = ui.patchPages(merged, op.patch, false, null, true, true, true);
			if (op.patch.f && Object.prototype.hasOwnProperty.call(op.patch.f, 'vars'))
			{
				mergedVars = op.patch.f.vars;
			}
		}
		return {pages: merged, vars: mergedVars};
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
				const incoming = Array.isArray(response) ? response : response.records;
				if (session !== s || ui.getCurrentFile() !== s.file) return;
				let changed = false;
				for (const op of incoming)
				{
					if (!s.records.has(op.id)) { changed = true; s.records.set(op.id, op); collectConflicts(s, op); }
				}
				if (changed) s.ordered = core.order([...s.records.values()], s.manifest.room);
				if (active(s) && response.peers) updatePeople(s, response.peers);
				if (graph.isEditing() || graph.mouseDown) return;
				// Edits may have happened while disk IO was in flight.
				await publish(s);
				if (session !== s || ui.getCurrentFile() !== s.file || graph.isEditing() || graph.mouseDown || dirty(s)) return;
				const ordered = s.ordered || core.order([...s.records.values()], s.manifest.room);
				const signature = ordered.ready.map(op => op.id).join(',');
				if (signature !== s.signature)
				{
					const merged = materialize(s, ordered);
					const patch = delta(s.baseline, merged.pages, s.vars, merged.vars);
					if (!mxUtils.isEmptyObject(patch)) s.file.patch([patch], null, false, false, true);
					s.baseline = pages();
					s.vars = vars();
					s.heads = ordered.heads;
					s.signature = signature;
					s.applied = ordered.ready.map(op => op.id);
					s.needsSnapshot = true;
				}
				// Persist a conventional .drawio view for exports and readers. Its
				// embedded heads prevent reopening an incomplete materialized view.
				let xml = s.snapshot;
				if (s.needsSnapshot)
				{
				const root = ui.getNodeForPages(s.baseline);
				root.setAttribute('sharemap-room', s.manifest.room);
				root.setAttribute('sharemap-heads', JSON.stringify(s.heads));
				xml = mxUtils.getXml(root);
				if (s.snapshot !== xml)
				{
					if (await call('snapshot', {xml, heads: s.heads}, s)) s.snapshot = xml;
				}
				if (s.snapshot === xml) s.needsSnapshot = false;
				}
				if (!active(s)) return;
				if (!dirty(s) && (s.file.isModified?.() || s.savedSignature !== signature || s.savedXml !== xml))
				{
					s.file.setModified(false);
					s.file.setShadowPages(ui.clonePages(s.baseline), s.vars);
					s.file.setData(xml);
					ui.descriptorChanged();
					ui.editor.setStatus('');
					s.savedSignature = signature;
					s.savedXml = xml;
				}
				const contributors = new Set(ordered.ready.map(op => op.author));
				contributors.add(s.author);
				savedStatus(s, ordered.pending);
				status.title = ordered.ready.length + ' saved edits · ' + contributors.size + ' contributors. ' +
					('Connected directly to ' + s.server + '. ') +
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
		const records = Array.isArray(response) ? response : response.records;
		if (session !== s || ui.getCurrentFile() !== s.file) return;
		for (const op of records) { s.records.set(op.id, op); collectConflicts(s, op); }
		const ordered = core.order(records, s.manifest.room);
		s.ordered = ordered;
		const required = JSON.parse(ui.fileNode.getAttribute('sharemap-heads') || '[]');
		const savedRoom = ui.fileNode.getAttribute('sharemap-room');
		if (savedRoom && savedRoom !== s.manifest.room) throw new Error('The map and collaboration folder belong to different shared sessions. Restore the matching folder.');
		const available = new Set(ordered.ready.map(op => op.id));
		if (!Array.isArray(required) || !required.every(id => available.has(id)) || ordered.pending)
		{
			throw new Error('Waiting for earlier server edits. Reconnect and retry.');
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
		s.signature = ordered.ready.map(op => op.id).join(',');
		s.applied = ordered.ready.map(op => op.id);
		s.needsSnapshot = true;
		s.initialized = true;
		autoSave.style.display = 'inline-block';
		autoSave.disabled = false;
		autoSave.textContent = 'AutoSave  On';
		autoSave.setAttribute('aria-pressed', 'true');
		s.file.setModified(false);
		ui.setGraphEnabled(s.file.isEditable());
		await cycle(s);
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
				session = null;
				reviewButton.style.display = 'none';
				showPeople([], {});
				autoSave.style.display = 'none';
				status.textContent = 'Open a shared map to collaborate';
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
				session = null;
				reviewButton.style.display = 'none';
				showPeople([], {});
				if (info)
				{
					if (info.mapName) { file.fileObject.name = info.mapName; file.title = info.mapName; ui.descriptorChanged(); }
					session = Object.assign(info, {file, path: file.fileObject.path, records: new Map(), heads: [], initialized: false});
					await initialize(session);
				}
				else
				{
					file.shareMapGuard = false;
					ui.setGraphEnabled(file.isEditable());
					autoSave.style.display = 'none';
					status.textContent = 'Open a shared map to collaborate';
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
		if (!s) throw new Error('Open a shared map first.');
		status.textContent = 'Checking sync…';
		const report = await call('diagnostics', {editor: editorDiagnostics(s)}, s);
		if (!active(s)) return;
		const div = document.createElement('div');
		div.style.cssText = 'padding:20px;font:13px Arial;line-height:1.5';
		const title = document.createElement('h2');
		title.textContent = 'Sync diagnostics';
		div.appendChild(title);
		const note = document.createElement('p');
		note.textContent = 'Compare Room, transport and edit fingerprint on both PCs. Different fingerprints mean edit records have not reached both copies. No diagram content is included.';
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
		title.textContent = 'Open shared map';
		div.appendChild(title);
		const note = document.createElement('p');
		note.textContent = 'Paste the shared-map link from your colleague. Your map opens from the collaboration server and reconnects automatically next time.';
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
		const label = document.createElement('label'); label.textContent = 'Your display name'; div.appendChild(label);
		const input = document.createElement('input');
		input.value = localStorage.getItem('.sharemapName') || session?.name || '';
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
		if (!file?.fileObject) throw new Error('Open or save the map first.');
		graph.stopEditing();
		ui.setGraphEnabled(false);
		try
		{
			const info = await call('serverCreate', {path: file.fileObject.path, xml: ui.getFileData(true)}, null);
			if (ui.getCurrentFile() !== file) throw new Error('The server map was created. Reopen it from Recent files after finishing this document.');
			file.setModified(false);
			ui.loadArgs({args: [info.path]});
		}
		finally { if (ui.getCurrentFile() === file) ui.setGraphEnabled(file.isEditable()); }
	}
	function serverAccess()
	{
		const s = session;
		const div = document.createElement('div');
		div.style.cssText = 'padding:20px;font:14px Arial;line-height:1.5';
		const title = document.createElement('h2');
		title.textContent = 'Share map';
		div.appendChild(title);
		const note = document.createElement('p');
		note.textContent = 'People with the link can edit this map while connected to your network or VPN. They install drawio-desktop-sync and use … → Open shared map. Keep the link within your team.';
		div.appendChild(note);
		button('Copy shared-map link', async () => { await call('copyLink', {}, s); status.textContent = 'Shared-map link copied'; ui.hideDialog(); }, div);
		if (s.owner) button('Revoke existing links', async () => { await call('rotateLink', {}, s); ui.hideDialog(); status.textContent = 'Links revoked'; }, div);
		button('Close', () => ui.hideDialog(), div);
		ui.showDialog(div, 540, 260, true, true);
	}

	const autoSave = button('AutoSave  On', () =>
	{
		if (!session) return;
		graph.stopEditing();
		session.paused = !session.paused;
		autoSave.textContent = 'AutoSave  ' + (session.paused ? 'Off' : 'On');
		autoSave.setAttribute('aria-pressed', String(!session.paused));
		status.textContent = session.paused ? 'AutoSave off · Ctrl+S to save' : 'Saving…';
		if (!session.paused) return cycle(session);
	});
		autoSave.style.display = 'none';
	autoSave.style.cssText += ';border:1px solid #8886;border-radius:14px;padding:5px 10px;white-space:nowrap';
	autoSave.title = 'Automatically save your edits and merge changes from the server';
	bar.insertBefore(autoSave, status);
	const share = button('Share', async () => { if (session) serverAccess(); else await serverCreate(); });
	share.style.cssText += ';background:#107c41;color:#fff;border:0;border-radius:5px;padding:6px 18px;font-weight:600';
	share.title = 'Share this map';
	button('⋯', () =>
	{
		const div = document.createElement('div');
		div.style.cssText = 'padding:20px;display:flex;flex-direction:column;gap:12px';
		button('Open shared map', () => { ui.hideDialog(); serverJoinDialog(); }, div);
		button('Your display name', () => { ui.hideDialog(); nameDialog(); }, div);
		button('Share current map on server', () => { ui.hideDialog(); return serverCreate(); }, div);
		button('Copy link for people with access', async () =>
		{
			if (!session) throw new Error('Open a shared map first.');
			await call('copyLink');
			ui.hideDialog();
			status.textContent = 'Link copied';
		}, div);
		button('Manage access', () => { if (!session) throw new Error('Open a shared map first.'); ui.hideDialog(); serverAccess(); }, div);
		button('Create desktop shortcut', async () => { await call('shortcut'); ui.hideDialog(); }, div);
		button('Sync diagnostics', () => { ui.hideDialog(); return diagnostics(); }, div);
		ui.showDialog(div, 310, 340, true, true);
	});
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
			// First save and Save As do not emit fileLoaded. Discover a newly
			// saved cloud file now so collaboration starts without reopening it.
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
					session = null;
					reviewButton.style.display = 'none';
					showPeople([], {});
					autoSave.style.display = 'none';
					this.shareMapGuard = false;
					status.textContent = 'Standalone copy · Collaborate to share';
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
		if (this.shareMapGuard || this === probing) { if (error) error({message: 'Wait for the shared map and its collaboration folder to finish opening'}); return; }
		return saveOrdinary(this, arguments);
	};
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
	// Keep the marker only on the journal's materialized view so copies can
	// initialize their own journal when saved to another cloud location.
	ui.editor.addListener('fileLoaded', () => open().catch(showError));
	timer = setInterval(() =>
	{
		if (session && session.file === ui.getCurrentFile())
		{
			if (session.initialized)
			{
				updateActivity(session);
				if (session.lastPeers) showPeople(session.lastPeers, session);
				if (!session.paused && Date.now() >= (session.retryAt || 0) && Date.now() - (session.lastCycle || 0) >= 1000) cycle(session);
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
	// Exposed on the existing UI object for integration tests and diagnostics.
	ui.sharedFolder = {open, reviewConflicts, resolveConflict, cycle: () => session && cycle(session), getSession: () => session, diagnostics, serverOpen, serverCreate};
	open().catch(showError);
});

/* Loaded locally into each editor after the desktop bootstrap. */
Draw.loadPlugin(function(ui)
{
	'use strict';
	if (ui.sharedFolder) return;
	const core = window.ShareMapJournal;
	const graph = ui.editor.graph;
	let session = null;
	let probing = null;
	let probeTask = null;
	let timer = null;
	const bar = document.createElement('div');
	bar.style.cssText = 'position:fixed;top:7px;right:150px;z-index:4;display:flex;align-items:center;gap:10px;padding:3px 6px;color:light-dark(#222,#eee);font:12px Arial,sans-serif;max-width:calc(100vw - 410px)';
	const status = document.createElement('span');
	status.textContent = 'Save to OneDrive to collaborate';
	status.style.cssText = 'max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
	bar.appendChild(status);
	const people = document.createElement('div');
	people.style.cssText = 'display:flex;gap:3px';
	bar.appendChild(people);
	let highlights = [];
	function showPeople(peers, s)
	{
		for (const highlight of highlights) highlight.destroy();
		highlights = [];
		people.replaceChildren();
		for (const peer of peers.slice(0, 6))
		{
			const color = ['#2b78d0', '#9854c6', '#bb6332', '#16836a'][parseInt(peer.author.replace(/-/g, '').slice(0, 4), 16) % 4];
			const avatar = document.createElement('span');
			avatar.textContent = peer.name.slice(0, 2).toUpperCase();
			avatar.title = peer.name + (peer.author === s.author ? ' (you)' : ' · recently active; presence follows OneDrive sync');
			avatar.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;border-radius:50%;width:25px;height:25px;color:white;background:' + color + ';font-size:10px';
			people.appendChild(avatar);
			if (peer.author !== s.author && ui.currentPage && peer.page === ui.currentPage.getId())
			{
				for (const id of peer.selection)
				{
					const cell = graph.model.getCell(id);
					const state = cell && graph.view.getState(cell);
					if (state)
					{
						const highlight = new mxCellHighlight(graph, color, 2, true);
						highlight.highlight(state);
						highlights.push(highlight);
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
		return !mxUtils.isEmptyObject(capture(s).patch);
	}
	async function publish(s)
	{
		const change = capture(s);
		if (!mxUtils.isEmptyObject(change.patch))
		{
			status.textContent = 'Saving edits locally…';
			const op = await call('append', {patch: change.patch, parents: s.heads,
				name: localStorage.getItem('.sharemapName') || s.name || ''}, s);
			s.records.set(op.id, op);
			s.heads = core.order([...s.records.values()], s.manifest.room).heads;
			s.baseline = change.pages;
			s.vars = change.vars;
		}
	}
	function materialize(s, ordered)
	{
		let merged = ui.getPagesForXml(s.manifest.base);
		let mergedVars = mxUtils.parseXml(s.manifest.base).documentElement.getAttribute('vars');
		for (const op of ordered.ready)
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
		s.running = (async () =>
		{
			try
			{
				// Do not interrupt a label edit or an active drag. Its final graph
				// transaction is captured on the next tick.
				if (graph.isEditing() || graph.mouseDown) return;
				await publish(s);
				const incoming = await call('scan', {}, s);
				if (session !== s || ui.getCurrentFile() !== s.file) return;
				for (const op of incoming) s.records.set(op.id, op);
				if (graph.isEditing() || graph.mouseDown) return;
				// Edits may have happened while disk IO was in flight.
				await publish(s);
				if (session !== s || ui.getCurrentFile() !== s.file || graph.isEditing() || graph.mouseDown || dirty(s)) return;
				const ordered = core.order([...s.records.values()], s.manifest.room);
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
				}
				// Persist a conventional .drawio view for exports and readers. Its
				// embedded heads prevent opening an incomplete OneDrive download.
				const root = ui.getNodeForPages(s.baseline);
				root.setAttribute('sharemap-room', s.manifest.room);
				root.setAttribute('sharemap-heads', JSON.stringify(s.heads));
				const xml = mxUtils.getXml(root);
				if (s.snapshot !== xml)
				{
					if (await call('snapshot', {xml, heads: s.heads}, s)) s.snapshot = xml;
				}
				if (!dirty(s))
				{
					s.file.setModified(false);
					s.file.setShadowPages(ui.clonePages(s.baseline), s.vars);
					s.file.setData(xml);
					ui.descriptorChanged();
					ui.editor.setStatus('');
				}
				const contributors = new Set(ordered.ready.map(op => op.author));
				contributors.add(s.author);
				status.textContent = ordered.pending ? 'Downloading changes…' : s.paused ? 'AutoSave off' : 'Saved locally';
				status.title = ordered.ready.length + ' saved edits · ' + contributors.size + ' contributors. ' +
					'Check the OneDrive icon for cloud sync status. Same-property edits use deterministic last-writer order; all edits remain in the journal.';
				s.error = null;
				if (!s.lastActivity || Date.now() - s.lastActivity > 10000)
				{
					s.lastActivity = Date.now();
					try
					{
						const peers = await call('activity', {name: localStorage.getItem('.sharemapName') || s.name,
							page: ui.currentPage && ui.currentPage.getId(), selection: graph.getSelectionCells().map(cell => cell.id)}, s);
						if (session === s) showPeople(peers, s);
					}
					catch { /* Presence is best effort; journal saving remains available. */ }
				}
			}
			catch (e)
			{
				s.error = e;
				status.textContent = 'Sync paused · Retry';
				status.title = e.message;
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
		const records = await call('scan', {}, s);
		if (session !== s || ui.getCurrentFile() !== s.file) return;
		for (const op of records) s.records.set(op.id, op);
		const ordered = core.order(records, s.manifest.room);
		const required = JSON.parse(ui.fileNode.getAttribute('sharemap-heads') || '[]');
		const savedRoom = ui.fileNode.getAttribute('sharemap-room');
		if (savedRoom && savedRoom !== s.manifest.room) throw new Error('The map and collaboration folder belong to different shared sessions. Restore the matching folder.');
		const available = new Set(ordered.ready.map(op => op.id));
		if (!Array.isArray(required) || !required.every(id => available.has(id)) || ordered.pending)
		{
			throw new Error('Waiting for OneDrive to download all earlier edits. Keep the map and its .collab folder available on this device.');
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
		s.initialized = true;
		autoSave.style.display = 'inline-block';
		autoSave.disabled = false;
		autoSave.textContent = 'AutoSave  On';
		autoSave.setAttribute('aria-pressed', 'true');
		s.file.setModified(false);
		ui.setGraphEnabled(true);
		await cycle(s);
		})();
		try { await s.initializing; }
		finally { s.initializing = null; }
	}
	async function flush(s)
	{
		await cycle(s);
		for (let attempt = 0; attempt < 3 && s.initialized && !s.error && dirty(s); attempt++) await cycle(s);
		if (s.error || !s.initialized || dirty(s)) throw s.error || new Error('Edits are still being saved. Retry.');
	}
	async function open(create = false)
	{
		if (probeTask)
		{
			await probeTask;
			if (create && !session) return open(true);
			return session;
		}
		const file = ui.getCurrentFile();
		if (!file || !file.fileObject || !/\.drawio$/i.test(file.fileObject.path))
		{
			if (create) throw new Error('Save this map as a .drawio file in your OneDrive-synced SharePoint folder first.');
			if (session && session.file !== file)
			{
				await call('close', {}, session);
				session = null;
				showPeople([], {});
				autoSave.style.display = 'none';
				status.textContent = 'Save to OneDrive to collaborate';
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
				const info = await call('open', {path: file.fileObject.path, seed: ui.getFileData(true), base: create ? ui.getFileData(true) : undefined}, null);
				if (file !== ui.getCurrentFile())
				{
					if (info) await call('close', {}, info);
					return;
				}
				if (session) await call('close', {}, session);
				session = null;
				showPeople([], {});
				if (info)
				{
					session = Object.assign(info, {file, path: file.fileObject.path, records: new Map(), heads: [], initialized: false});
					await initialize(session);
				}
				else if (ui.fileNode && ui.fileNode.getAttribute('sharemap-room'))
				{
					// Fail closed: never silently treat a collaborative snapshot as
					// an ordinary file when its journal hasn't downloaded yet.
					throw new Error('The .collab folder is missing. Download it beside the map before editing.');
				}
				else
				{
					file.shareMapGuard = false;
					ui.setGraphEnabled(true);
					autoSave.style.display = 'none';
					status.textContent = 'Save to OneDrive to collaborate';
				}
				return session;
			}
			finally
			{
				probing = null;
				probeTask = null;
			}
		})();
		return probeTask;
	}
	function dialog()
	{
		const div = document.createElement('div');
		div.style.cssText = 'padding:20px;font:14px Arial;line-height:1.5';
		const title = document.createElement('h2');
		title.textContent = 'SharePoint collaboration';
		div.appendChild(title);
		const text = document.createElement('p');
		text.textContent = 'Keep the map and its .collab folder together in your synced SharePoint folder. Everyone edits with ShareMap Desktop. Changes merge when OneDrive syncs; there is no additional server. Mark both items “Always keep on this device”.';
		div.appendChild(text);
		const nameLabel = document.createElement('label');
		nameLabel.textContent = 'Your name';
		const name = document.createElement('input');
		name.value = localStorage.getItem('.sharemapName') || '';
		name.placeholder = 'Name shown with your edits';
		name.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin:4px 0 12px;padding:8px';
		nameLabel.appendChild(name);
		div.appendChild(nameLabel);
		const linkLabel = document.createElement('label');
		linkLabel.textContent = 'SharePoint folder link (optional)';
		const link = document.createElement('input');
		link.placeholder = 'Paste the folder link from OneDrive → Share → Copy link';
		link.style.cssText = name.style.cssText;
		linkLabel.appendChild(link);
		div.appendChild(linkLabel);
		if (session) call('link').then(value => { link.value = value; }).catch(showError);
		const note = document.createElement('p');
		note.textContent = 'Share the containing folder with Edit access so collaborators receive the edit journal too. SharePoint controls access; this app does not grant permissions. Initialize once, let OneDrive finish, then invite others. Two edits to the same property use a consistent last-writer order.';
		note.style.fontSize = '12px';
		div.appendChild(note);
		const controls = document.createElement('div');
		controls.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
		div.appendChild(controls);
		button('Show in OneDrive folder', async () =>
		{
			if (!session) await open(true);
			if (session) await call('reveal');
		}, controls);
		button(session ? 'Save / Copy link' : 'Enable AutoSave & merging', async () =>
		{
			localStorage.setItem('.sharemapName', name.value.trim().slice(0, 80));
			if (!session) await open(true);
			if (session && link.value.trim())
			{
				await call('link', {url: link.value.trim()});
				await call('copyLink');
				status.textContent = 'SharePoint folder link copied';
			}
			ui.hideDialog();
		}, controls);
		button('Close', () => ui.hideDialog(), controls);
		ui.showDialog(div, 570, 400, true, true);
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
	autoSave.title = 'Automatically save your edits and merge changes delivered by OneDrive';
	bar.insertBefore(autoSave, status);
	const share = button('Share', async () =>
	{
		if (session && session.cloud) await call('shareNative');
		else dialog();
	});
	share.style.cssText += ';background:#107c41;color:#fff;border:0;border-radius:5px;padding:6px 18px;font-weight:600';
	share.title = 'Share this map’s folder with OneDrive';
	button('⋯', () =>
	{
		const div = document.createElement('div');
		div.style.cssText = 'padding:20px;display:flex;flex-direction:column;gap:12px';
		button('Copy link for people with access', async () =>
		{
			if (!session) throw new Error('Save the map in a OneDrive-synced folder first.');
			await call('copyLink');
			ui.hideDialog();
			status.textContent = 'Link copied';
		}, div);
		button('Manage access', async () =>
		{
			if (!session) throw new Error('Save the map in a OneDrive-synced folder first.');
			await call('manageAccess');
			ui.hideDialog();
		}, div);
		button('Collaboration details', () => { ui.hideDialog(); dialog(); }, div);
		ui.showDialog(div, 290, 160, true, true);
	});
	status.style.cursor = 'pointer';
	status.addEventListener('click', () =>
	{
		if (session && session.initialized) cycle(session).then(() => { if (session.error) showError(session.error); });
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
					if (s.error || dirty(s)) throw s.error || new Error('Wait for your edits to save before exporting a copy.');
					await call('close', {}, s);
					session = null;
					showPeople([], {});
					this.shareMapGuard = false;
					status.textContent = 'Standalone copy · Collaborate to share';
					originalSave.apply(this, args);
				}).catch(e => { if (error) error(e); else showError(e); });
				return;
			}
			graph.stopEditing();
			flush(session).then(() =>
			{
				if (session.error || !session.initialized || dirty(session)) throw session.error || new Error('Edits are still being saved. Retry.');
				if (success) success();
			}).catch(e => { if (error) error(e); else showError(e); });
			return;
		}
		if (this.shareMapGuard || this === probing) { if (error) error({message: 'Wait for the shared map and its collaboration folder to finish opening'}); return; }
		return originalSave.apply(this, arguments);
	};
	const originalChange = ui.handleFileChange;
	ui.handleFileChange = function(curr, prev, file)
	{
		if (session && session.file === file) { session.snapshot = null; return; }
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
			cycle(session).then(() =>
			{
				if (session.error) throw session.error;
				if (success) success();
			}).catch(error || showError);
		}
		else return originalSync.apply(this, arguments);
	};
	// Save As exports a standalone copy; strip the marker from exported data
	// by keeping it only on the journal's materialized view, not ui.fileNode.
	ui.editor.addListener('fileLoaded', () => open().catch(showError));
	timer = setInterval(() =>
	{
		if (session && session.file === ui.getCurrentFile())
		{
			if (session.initialized && !session.paused) cycle(session);
			else if (!session.initialized) initialize(session).catch(e => { status.textContent = 'Waiting for OneDrive · Click for details'; status.title = e.message; });
		}
	}, 1000);
	window.addEventListener('unload', () => clearInterval(timer));
	// Exposed on the existing UI object for integration tests and diagnostics.
	ui.sharedFolder = {open, cycle: () => session && cycle(session), getSession: () => session, dialog};
	open().catch(showError);
});

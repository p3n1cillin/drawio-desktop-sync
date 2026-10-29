/* Show Changes and Comments for shared maps, in the style of Office co-authoring.
 * Loaded after shared-folder.js and driven by its session events. */
Draw.loadPlugin(function(ui)
{
	'use strict';
	const shared = ui.sharedFolder;
	if (!shared || ui.collaborationPanels) return;
	const changeLog = window.ShareMapChanges;
	const graph = ui.editor.graph;
	const call = shared.call;
	function current()
	{
		const s = shared.getSession();
		return s?.initialized && shared.active(s) ? s : null;
	}
	function isShared(file)
	{
		const s = shared.getSession();
		return !!(s?.initialized && s.file === file);
	}
	function element(tag, text, css, parent)
	{
		const node = document.createElement(tag);
		if (text) node.textContent = text;
		if (css) node.style.cssText = css;
		if (parent) parent.appendChild(node);
		return node;
	}
	function colorOf(text)
	{
		let hash = 0;
		for (const char of String(text)) hash = (hash * 31 + char.charCodeAt(0)) | 0;
		return ['#2b78d0', '#9854c6', '#bb6332', '#16836a', '#c23985', '#567c26', '#a35e1b', '#5369be'][Math.abs(hash) % 8];
	}
	function when(time)
	{
		if (!time) return '';
		const seconds = Math.round((Date.now() - time) / 1000);
		if (seconds < 45) return 'Just now';
		if (seconds < 3600) return Math.round(seconds / 60) + ' min ago';
		if (seconds < 6 * 3600) return Math.round(seconds / 3600) + ' h ago';
		return new Date(time).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'});
	}

	// Show Changes: who changed what and when, newest first, for the map or the selection.
	let log = null;
	let pane = null;
	let list = null;
	let onlySelection = false;
	let renderQueued = false;
	function baseLabels(base)
	{
		const labels = {};
		const pages = {};
		for (const diagram of Array.from(mxUtils.parseXml(base).documentElement.getElementsByTagName('diagram')))
		{
			const page = diagram.getAttribute('id');
			pages[page] = diagram.getAttribute('name') || 'Page';
			const model = Editor.parseDiagramNode(diagram);
			for (const node of model ? Array.from(model.getElementsByTagName('*')) : [])
			{
				const id = node.getAttribute('id');
				if (!id) continue;
				const label = node.nodeName === 'mxCell' ? node.getAttribute('value') : node.getAttribute('label');
				labels[page + '\n' + id] = changeLog.plain(label || '');
			}
		}
		return {labels, pages};
	}
	// Describes only edits that arrived since the last refresh.
	async function refreshLog(s)
	{
		const ready = s.ordered.ready;
		if (!log || log.session !== s || (log.state.count && ready[log.state.count - 1]?.id !== log.state.last))
		{
			const base = baseLabels(s.manifest.base);
			log = {session: s, state: changeLog.createState(base.labels, base.pages), times: {}};
			if (ready.some(op => !Number.isSafeInteger(op.time)))
			{
				try { log.times = (await call('history')).times || {}; }
				catch { /* Older servers cannot date edits saved before they recorded times. */ }
			}
		}
		changeLog.apply(log.state, ready.slice(log.state.count), log.times);
	}
	function buildPane()
	{
		pane = element('div', '', 'position:fixed;top:52px;right:10px;bottom:10px;width:330px;z-index:5;display:none;flex-direction:column;' +
			'background:light-dark(#fff,#262626);color:light-dark(#222,#eee);border:1px solid #8885;border-radius:8px;box-shadow:0 6px 24px #0004;font:13px Arial', document.body);
		pane.className = 'geSyncChanges';
		const header = element('div', '', 'display:flex;align-items:center;padding:10px 12px;border-bottom:1px solid #8884', pane);
		element('div', 'Changes', 'flex:1;font-weight:600;font-size:15px', header);
		const close = element('button', '×', 'border:0;background:none;color:inherit;font-size:18px;cursor:pointer', header);
		close.title = 'Close';
		close.addEventListener('click', () => { pane.style.display = 'none'; });
		const filters = element('div', '', 'display:flex;gap:6px;padding:8px 12px', pane);
		for (const [value, text] of [[false, 'All changes'], [true, 'Selected shapes']])
		{
			const option = element('button', text, 'flex:1;padding:4px;border:1px solid #8886;border-radius:4px;background:none;color:inherit;cursor:pointer', filters);
			option.dataset.selection = String(value);
			option.addEventListener('click', () => { onlySelection = value; queueRender(); });
		}
		list = element('div', '', 'flex:1;overflow:auto;padding:0 12px 12px', pane);
		graph.getSelectionModel().addListener(mxEvent.CHANGE, () => { if (onlySelection) queueRender(); });
		ui.editor.addListener('fileLoaded', () => { pane.style.display = 'none'; });
		// One side pane at a time, like Office: showing comments closes Changes.
		ui.addListener('comments', () => { if (ui.menus.commentsWindow?.window.isVisible()) pane.style.display = 'none'; });
	}
	function queueRender()
	{
		if (renderQueued || !pane || pane.style.display === 'none') return;
		renderQueued = true;
		requestAnimationFrame(() =>
		{
			renderQueued = false;
			const s = current();
			if (s) refreshLog(s).then(() => render(s)).catch(shared.showError);
		});
	}
	function render(s)
	{
		for (const option of pane.querySelectorAll('[data-selection]'))
		{
			option.style.background = option.dataset.selection === String(onlySelection) ? '#8883' : 'none';
		}
		const page = ui.currentPage?.getId();
		const selected = new Set(graph.getSelectionCells().map(cell => cell.id));
		const entries = [];
		for (let index = log.state.entries.length - 1; index >= 0 && entries.length < 250; index--)
		{
			const entry = log.state.entries[index];
			if (!onlySelection || (entry.page === page && selected.has(entry.cell))) entries.push(entry);
		}
		const fragment = document.createDocumentFragment();
		if (!entries.length) element('div', onlySelection ? 'No changes to the selected shapes.' : 'No changes yet.', 'padding:20px 0;opacity:.7;text-align:center', fragment);
		for (const entry of entries)
		{
			const card = element('div', '', 'padding:8px 10px;margin-top:8px;border-radius:6px;border-left:4px solid ' + colorOf(entry.author) + ';background:#8881;cursor:pointer', fragment);
			card.className = 'geSyncChange';
			const top = element('div', '', 'display:flex;gap:8px', card);
			element('div', entry.author, 'flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', top);
			const time = element('div', when(entry.time), 'opacity:.7;font-size:12px', top);
			if (entry.time) time.title = new Date(entry.time).toLocaleString();
			element('div', entry.text, 'margin-top:2px;word-break:break-word', card);
			if (entry.page && entry.page !== page && entry.pageName) element('div', 'On page ' + entry.pageName, 'opacity:.7;font-size:12px', card);
			card.addEventListener('click', () => reveal(entry));
		}
		list.replaceChildren(fragment);
	}
	function reveal(entry)
	{
		const target = ui.pages?.find(page => page.getId() === entry.page);
		if (target && target !== ui.currentPage) ui.selectPage(target);
		const cell = entry.cell && graph.model.getCell(entry.cell);
		if (cell) { graph.setSelectionCell(cell); graph.scrollCellToVisible(cell); }
	}
	function showChanges(selectionOnly)
	{
		if (!current()) throw new Error('Open a shared diagram first.');
		if (!pane) buildPane();
		onlySelection = !!selectionOnly;
		ui.menus.commentsWindow?.window.setVisible(false);
		pane.style.display = 'flex';
		queueRender();
	}
	shared.addMenuItem('Show changes', () => showChanges(false), () => current());
	const createPopupMenu = ui.menus.createPopupMenu;
	ui.menus.createPopupMenu = function(menu)
	{
		createPopupMenu.apply(this, arguments);
		if (current() && graph.getSelectionCount() > 0)
		{
			menu.addSeparator();
			menu.addItem('Show changes', null, () => showChanges(true));
		}
	};

	// Comments: the editor's own comments window, stored on the collaboration server.
	function userOf(author)
	{
		return author ? new DrawioUser(author.id, author.email || null, author.name) : null;
	}
	function ShareMapComment(file, item, parent)
	{
		DrawioComment.call(this, file, item.id, item.content, item.modified, item.created, !!item.resolved, userOf(item.author));
		this.pCommentId = parent || null;
		this.anchor = item.anchor || null;
	}
	mxUtils.extend(ShareMapComment, DrawioComment);
	ShareMapComment.prototype.addReply = function(reply, success, error, doResolve, doReopen)
	{
		call('comment', {op: 'reply', parent: this.pCommentId || this.id, content: reply.content, resolve: !!doResolve, reopen: !!doReopen}).then(result =>
		{
			if (doResolve) this.isResolved = true;
			if (doReopen) this.isResolved = false;
			success(result.id);
		}, error);
	};
	ShareMapComment.prototype.editComment = function(content, success, error)
	{
		call('comment', {op: 'edit', comment: this.id, content}).then(() => success(), error);
	};
	ShareMapComment.prototype.deleteComment = function(success, error)
	{
		call('comment', {op: 'delete', comment: this.id}).then(() => success(), error);
	};
	function threads(file, items)
	{
		const top = new Map();
		for (const item of items) if (!item.parent) top.set(item.id, new ShareMapComment(file, item));
		for (const item of items) if (item.parent) top.get(item.parent)?.addReplyDirect(new ShareMapComment(file, item, item.parent));
		return [...top.values()];
	}
	function override(name, value)
	{
		const original = LocalFile.prototype[name];
		LocalFile.prototype[name] = function()
		{
			return isShared(this) ? value.apply(this, arguments) : original?.apply(this, arguments);
		};
	}
	override('commentsSupported', () => true);
	override('anchoredCommentsSupported', () => true);
	override('mentionsSupported', () => true);
	override('freeMentionsSupported', () => false);
	override('mentionNotificationsSupported', () => true);
	// Comment changes are pushed, so the window needs no refresh or save buttons.
	override('commentsRefreshNeeded', () => false);
	override('commentsSaveNeeded', () => false);
	override('canReplyToReplies', () => false);
	override('canComment', () => shared.getSession().role !== 'view');
	override('getComments', function(success, error) { call('comments').then(result => success(threads(this, result.comments)), error); });
	override('addComment', function(comment, success, error) { call('comment', {op: 'add', content: comment.content, anchor: comment.anchor}).then(result => success(result.id), error); });
	override('newComment', function(content, user)
	{
		const comment = new ShareMapComment(this, {id: null, content, created: Date.now(), modified: Date.now(), resolved: false});
		comment.user = user;
		return comment;
	});
	override('getMentionCandidates', function(success, error) { call('people').then(people => success(people.map(person => new DrawioUser(person.email, person.email, person.name))), error); });
	const getCurrentUser = ui.getCurrentUser;
	ui.getCurrentUser = function()
	{
		const s = current();
		return s ? new DrawioUser(s.email || s.client, s.email || null, shared.displayName()) : getCurrentUser?.apply(this, arguments);
	};
	const commentsButton = shared.addBarButton('Comments', () => ui.actions.get('comments').funct(), 'Show comments');

	// Mentions notify like Office: a banner in the map and a desktop notification.
	let banner = null;
	function notify(s, item)
	{
		const text = (item.author?.name || 'Someone') + ' mentioned you in a comment';
		const body = changeLog.plain(item.content.replace(/[+@][^\s@]+@[^\s]+/g, match => '@' + match.slice(1).split('@')[0]));
		if (!banner)
		{
			banner = element('div', '', 'position:fixed;right:16px;bottom:16px;z-index:6;max-width:360px;padding:12px 14px;border-radius:8px;' +
				'background:light-dark(#fff,#2d2d2d);color:light-dark(#222,#eee);border:1px solid #8885;box-shadow:0 6px 24px #0004;font:13px Arial;cursor:pointer', document.body);
			banner.className = 'geSyncMention';
			banner.addEventListener('click', () => { banner.style.display = 'none'; ui.menus.showCommentsWindow?.(banner.cellId); });
		}
		banner.cellId = item.anchor?.c || null;
		banner.replaceChildren();
		element('div', text, 'font-weight:600', banner);
		element('div', body.slice(0, 200), 'margin-top:4px', banner);
		banner.style.display = 'block';
		try { if (typeof Notification === 'function' && Notification.permission !== 'denied') new Notification(text, {body: body.slice(0, 200)}); }
		catch { /* The banner remains when desktop notifications are unavailable. */ }
	}
	async function checkMentions(s)
	{
		if (!s.email) return;
		const key = '.sharemapMentionSeen.' + s.manifest.room;
		const seen = Number(localStorage.getItem(key)) || 0;
		const {comments} = await call('comments');
		const token = s.email.toLowerCase();
		const fresh = comments.filter(item => item.created > seen && item.author?.id !== s.email &&
			(item.content.toLowerCase().includes('+' + token) || item.content.toLowerCase().includes('@' + token)));
		if (fresh.length) notify(s, fresh.at(-1));
		const newest = Math.max(seen, ...comments.map(item => item.created));
		if (newest > seen) localStorage.setItem(key, String(newest));
	}

	shared.on((type, s) =>
	{
		if (type === 'session')
		{
			commentsButton.style.display = '';
			log = null;
		}
		else if (type === 'closed')
		{
			commentsButton.style.display = 'none';
			if (pane) pane.style.display = 'none';
			if (banner) banner.style.display = 'none';
			log = null;
		}
		else if (type === 'records') queueRender();
		else if (type === 'comments' && shared.active(s))
		{
			ui.refreshCommentCache?.();
			const comments = ui.menus.commentsWindow;
			if (comments?.window.isVisible()) comments.refreshComments();
			checkMentions(s).catch(() => {});
		}
	});
	ui.collaborationPanels = {showChanges, getLog: () => log};
});

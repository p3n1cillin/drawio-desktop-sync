// Keep the upstream visual/JSON configuration editor; add durable preferences
// and apply supported changes to existing editor objects without reloading them.
Draw.loadPlugin(function(ui)
{
	if (ui.livePreferences) return;
	const graph = ui.editor.graph;
	const {isPreferenceKey} = window.DrawioPreferenceKeys;
	const originalSet = Storage.prototype.setItem;
	const originalRemove = Storage.prototype.removeItem;
	const originalClear = Storage.prototype.clear;
	const bindings = new Map();
	const readConfig = value =>
	{
		const parsed = value ? JSON.parse(value) : {};
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Configuration must be a JSON object');
		return parsed;
	};
	let current = {};
	try { current = readConfig(localStorage.getItem(Editor.configurationKey)); }
	catch (error) { console.error('Could not read Configuration:', error); }
	let notice;
	let lastResult = {applied: [], deferred: []};
	function bind(key, object, property, validate, apply, fallback)
	{
		const initial = object[property];
		bindings.set(key, {validate, fallback: Object.hasOwn(current, key) ? fallback : initial,
			resettable: !Object.hasOwn(current, key) || fallback !== undefined,
			set(value) { object[property] = value; if (apply) apply(value); }});
	}
	const bool = value => typeof value === 'boolean';
	const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
	const positiveInteger = value => Number.isInteger(value) && value > 0;
	const booleanEditors = ['simpleLabels', 'optimizeHtmlLabels', 'fastRendering', 'mathOutputSize',
		'defaultTransparentGroups', 'pasteAtMousePointer', 'fitDiagramOnLoad', 'fitDiagramOnPage',
		'showLinkIcons', 'showTooltipIcons', 'showNoteIcons', 'showConnectHandle', 'enableInlineToolbar',
		'enableAnimations', 'insertAnimations', 'enableWindowDocking', 'enableNativeClipboard', 'expandPatternsForPrint'];
	const labelDefaults = {simpleLabels: false, optimizeHtmlLabels: false, fastRendering: true,
		mathOutputSize: true, defaultTransparentGroups: false};
	for (const key of booleanEditors) bind(key, Editor, key, bool, null, labelDefaults[key]);
	bind('enablePositionGuides', mxGuide.prototype, 'positionEnabled', bool, null, true);
	bind('enableDistanceGuides', mxGuide.prototype, 'distanceEnabled', bool, null, true);
	bind('enableSizeGuides', mxVertexHandler.prototype, 'sizeGuidesEnabled', bool, null, true);
	bind('zoomWheel', Graph, 'zoomWheel', bool, value =>
	{
		// Also update the corresponding user preference, so it cannot undo the
		// explicit Configuration choice the next time this editor opens.
		mxSettings.settings.zoomWheel = value;
		mxSettings.save();
	}, mxSettings.settings.zoomWheel ?? Graph.trackpadDetection);
	bind('copyOnConnect', mxConnectionHandler.prototype, 'createTarget', bool,
		value => { if (graph.connectionHandler) graph.connectionHandler.createTarget = value; }, urlParams.sketch === '1');
	bind('defaultConnectable', Graph.prototype, 'defaultConnectable', bool,
		value => graph.setConnectable(value), true);
	bind('defaultConnectionArrowsEnabled', Graph.prototype, 'defaultConnectionArrowsEnabled', bool, value =>
	{
		Graph.prototype.connectionArrowsEnabled = value;
		graph.connectionArrowsEnabled = value;
		graph.connectionArrows?.reset();
	}, true);
	bind('defaultFoldingEnabled', Graph.prototype, 'defaultFoldingEnabled', bool,
		value => { graph.foldingEnabled = value; graph.view.revalidate(); }, true);
	bind('stopEditingOnEnter', mxGraph.prototype, 'enterStopsCellEditing', bool,
		value => { graph.enterStopsCellEditing = value; }, false);
	bind('updateDefaultStyle', EditorUi.prototype, 'updateDefaultStyle', bool,
		value => { ui.updateDefaultStyle = value; }, false);
	bind('noAutoFocus', EditorUi.prototype, 'noAutoFocus', bool, value => { ui.noAutoFocus = value; }, false);
	bind('compact', EditorUi.prototype, 'defaultCompact', bool,
		value => ui.setCompactMode?.(value, false), mxSettings.settings.compactMode ?? false);
	bind('browserTranslate', Graph, 'browserTranslate', bool, value =>
	{
		if (value) graph.waitForBrowserTranslate?.();
		else graph.destroyBrowserTranslate?.();
	}, mxClient.IS_GC && urlParams['browser-translate'] !== '0');
	bind('defaultGridSize', mxGraph.prototype, 'gridSize', positiveInteger,
		value => { graph.gridSize = value; graph.view.validateBackground(); }, 10);
	bind('gridSteps', mxGraphView.prototype, 'gridSteps', positiveInteger,
		value => { graph.view.gridSteps = value; graph.view.validateBackground(); }, 4);
	bind('zoomFactor', Graph.prototype, 'zoomFactor', value => positive(value) && value > 1,
		value => { graph.zoomFactor = value; }, 1.2);
	bind('autosaveDelay', DrawioFile.prototype, 'autosaveDelay', positiveInteger);
	bind('tooltipFontSize', Editor, 'tooltipFontSize', positiveInteger);
	bind('tooltipMaxWidth', Editor, 'tooltipMaxWidth', value => Number.isInteger(value) && value >= 0);
	bind('defaultEdgeLength', Graph.prototype, 'defaultEdgeLength', positive);
	bind('compressXml', Editor, 'defaultCompressed', bool, value => { Editor.compressXml = value; });
	bind('includeDiagram', Editor, 'defaultIncludeDiagram', bool);
	bind('selectParentLayer', Graph, 'selectParentLayer', bool);
	bind('intersectionSelect', Graph, 'intersectionSelect', bool);
	bind('swimlaneSelectionEnabled', Graph.prototype, 'swimlaneSelectionEnabled', bool);
	bind('multiSelectionHandles', Graph.prototype, 'multiSelectionHandlesEnabled', bool);

	function applyConfiguration(value, before = current)
	{
		const next = readConfig(value);
		const result = {applied: [], deferred: []};
		const changed = [...new Set([...Object.keys(before), ...Object.keys(next)])].filter(key =>
			JSON.stringify(before[key]) !== JSON.stringify(next[key]));
		// Validate all supported fields before changing any runtime state.
		for (const key of changed)
		{
			const binding = bindings.get(key);
			if (binding && next[key] != null && !binding.validate(next[key])) throw new Error('Invalid configuration value: ' + key);
		}
		for (const key of changed)
		{
			const binding = bindings.get(key);
			if (binding && (next[key] != null || binding.resettable))
			{
				binding.set(next[key] ?? binding.fallback);
				result.applied.push(key);
				// Keep only live fields current. Startup-only file grants, plugin
				// loading and identity settings remain unchanged in this window.
				if (Editor.config) { if (next[key] == null) delete Editor.config[key]; else Editor.config[key] = next[key]; }
			}
			else result.deferred.push(key);
		}
		current = next;
		lastResult = result;
		return result;
	}
	function changed(key, value)
	{
		if (key === Editor.configurationKey)
		{
			const result = applyConfiguration(value);
			notice = {result, at: Date.now()};
		}
		window.dispatchEvent(new CustomEvent('drawio-preference-changed', {detail: {key, value}}));
	}
	function persistChange(key, value, operation)
	{
		key = String(key);
		if (!isPreferenceKey(key)) return operation();
		if (key === Editor.configurationKey)
		{
			const next = readConfig(value);
			for (const [name, binding] of bindings)
				if (next[name] != null && !binding.validate(next[name])) throw new Error('Invalid configuration value: ' + name);
		}
		const previous = localStorage.getItem(key);
		operation();
		try { electron.persistPreferences({[key]: value}); }
		catch (error)
		{
			if (previous === null) originalRemove.call(localStorage, key);
			else originalSet.call(localStorage, key, previous);
			throw error;
		}
		changed(key, value);
	}
	Storage.prototype.setItem = function(key, value)
	{
		if (arguments.length < 2) return originalSet.apply(this, arguments);
		return this === localStorage ? persistChange(key, String(value), () => originalSet.call(this, key, value)) : originalSet.call(this, key, value);
	};
	Storage.prototype.removeItem = function(key)
	{
		if (!arguments.length) return originalRemove.apply(this, arguments);
		return this === localStorage ? persistChange(key, null, () => originalRemove.call(this, key)) : originalRemove.call(this, key);
	};
	Storage.prototype.clear = function()
	{
		if (this !== localStorage) return originalClear.call(this);
		const entries = Object.fromEntries(Object.keys(localStorage).filter(isPreferenceKey).map(key => [key, null]));
		electron.persistPreferences(entries);
		originalClear.call(this);
		for (const key of Object.keys(entries)) changed(key, null);
	};
	window.addEventListener('storage', event =>
	{
		if (event.storageArea === localStorage && isPreferenceKey(event.key))
		{
			try { changed(event.key, event.newValue); }
			catch (error) { ui.handleError(error); }
		}
	});
	const alert = ui.alert;
	ui.alert = function(message)
	{
		if (message === mxResources.get('restartForChangeRequired') && notice && Date.now() - notice.at < 1000)
		{
			const {deferred} = notice.result;
			notice = null;
			if (!deferred.length) return;
			message = 'Configuration saved. Available changes are applied now. These settings take effect in a new editor window: ' + deferred.join(', ') + '.';
		}
		return alert.call(this, message);
	};
	// Adopt existing preferences once. Further saves are synchronous and atomic
	// in the native profile store, not delayed until the app exits.
	try
	{
		electron.persistPreferences(Object.fromEntries(Object.keys(localStorage).filter(isPreferenceKey).map(key => [key, localStorage.getItem(key)])));
	}
	catch (error) { ui.handleError(error); }
	// The upstream "compact" control is labelled Compact UI. Apply that visual
	// preference on new windows as well as when Apply is clicked.
	if (typeof current.compact === 'boolean') ui.setCompactMode?.(current.compact, false);
	const desktop = {enableSpellCheck: urlParams.enableSpellCheck === '1',
		enableStoreBkp: urlParams.enableStoreBkp === '1', autoUpdate: urlParams.autoUpdate === '1'};
	for (const [actionName, key, channel] of [['spellCheck', 'enableSpellCheck', 'toggleSpellCheck'],
		['autoBkp', 'enableStoreBkp', 'toggleStoreBkp'], ['autoUpdate', 'autoUpdate', 'toggleAutoUpdate']])
	{
		const action = ui.actions.get(actionName);
		if (action)
		{
			action.funct = () => electron.sendMessage(channel);
			action.setSelectedCallback(() => desktop[key]);
		}
	}
	electron.registerMsgListener('desktop-preferences', state =>
	{
		Object.assign(desktop, state);
		for (const [key, value] of Object.entries(state)) urlParams[key] = value ? '1' : '0';
	});
	ui.livePreferences = {applyConfiguration, getResult: () => lastResult};
});

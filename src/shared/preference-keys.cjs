(function(root) {
	function isPreferenceKey(key)
	{
		return typeof key === 'string' && key.length <= 160 &&
			(/^(?:\.configuration|\.drawio-config|\._autoSaveTrans_|\.sharemapName|\.pdfAutosave|\.last(?:Exp|Imp|Open|Save)Dir|\.drawio-elk-layout-settings)$/.test(key) ||
			 /^\.[\w-]+-(?:configuration|config)$/.test(key) ||
			 /^\.sharemapReviewed\.[a-f0-9-]{36}$/.test(key) ||
			 /^\.sharemapAutoSave\.[a-f0-9-]{36}\.[a-f0-9-]{36}$/.test(key));
	}
	if (typeof module !== 'undefined' && module.exports) module.exports = {isPreferenceKey};
	else root.DrawioPreferenceKeys = {isPreferenceKey};
})(typeof window !== 'undefined' ? window : globalThis);

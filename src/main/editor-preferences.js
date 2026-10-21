// Preferences live in the user profile, independently of the installed app and
// Chromium's localStorage database. Never copy diagrams, drafts or login tokens.
import keys from '../shared/preference-keys.cjs';
export const {isPreferenceKey} = keys;

export class EditorPreferences
{
	constructor(store) { this.store = store; }
	read()
	{
		const entries = this.store.get('entries') || {};
		return Object.fromEntries(Object.entries(entries).filter(([key, value]) =>
			isPreferenceKey(key) && (value === null || typeof value === 'string')));
	}
	write(key, value)
	{
		return this.writeMany({[key]: value});
	}
	writeMany(changes)
	{
		if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('Invalid editor preferences');
		const entries = this.read();
		let changed = false;
		for (const [key, value] of Object.entries(changes))
		{
			if (!isPreferenceKey(key) || (value !== null && typeof value !== 'string') || (value?.length || 0) > 2 * 1024 * 1024)
				throw new Error('Invalid editor preference');
			if (entries[key] !== value || !Object.hasOwn(entries, key)) { entries[key] = value; changed = true; }
		}
		if (!changed) return;
		if (Object.keys(entries).length > 512 || JSON.stringify(entries).length > 4 * 1024 * 1024) throw new Error('Editor preferences are too large');
		// Null remembers an explicit reset so an older cache cannot resurrect it.
		this.store.set('entries', entries);
	}
}

export function registerEditorPreferences({ipcMain, validateSender, preferences})
{
	ipcMain.on('editor-preferences', (event, request) =>
	{
		try
		{
			if (!validateSender(event.senderFrame) || event.senderFrame !== event.sender.mainFrame) throw new Error('Preference access denied');
			if (request?.action === 'read') event.returnValue = {entries: preferences.read()};
			else if (request?.action === 'write')
			{
				preferences.writeMany(request.entries);
				event.returnValue = {saved: true};
			}
			else throw new Error('Invalid preference request');
		}
		catch (error) { event.returnValue = {error: error.message}; }
	});
}

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveSyncLocation} from '../main/onedrive-shell.js';

test('any registered SharePoint library maps to its own web namespace', () =>
{
	const roots = [{MountPoint: 'C:\\Users\\Any User\\Company\\IT - Documents', UrlNamespace: 'https://example.sharepoint.com/sites/IT/Shared Documents/'}];
	const location = resolveSyncLocation('C:\\Users\\Any User\\Company\\IT - Documents\\Floor plans\\Map & Assets.drawio', roots);
	assert.equal(location.fileUrl, 'https://example.sharepoint.com/sites/IT/Shared%20Documents/Floor%20plans/Map%20%26%20Assets.drawio');
	assert.equal(location.folderUrl, 'https://example.sharepoint.com/sites/IT/Shared%20Documents/Floor%20plans/');
});

test('uses longest matching mount, ignores siblings and rejects untrusted namespaces', () =>
{
	const roots = [
		{MountPoint: 'C:\\Sync', UrlNamespace: 'https://example.sharepoint.com/sites/A/'},
		{MountPoint: 'C:\\Sync\\Nested', UrlNamespace: 'https://example.sharepoint.com/sites/B/'}];
	assert.match(resolveSyncLocation('c:\\sync\\nested\\map.drawio', roots).fileUrl, /sites\/B\/map/);
	assert.equal(resolveSyncLocation('C:\\Sync-other\\map.drawio', roots), null);
	assert.equal(resolveSyncLocation('C:\\Sync\\map.drawio', [{MountPoint: 'C:\\Sync', UrlNamespace: 'https://evil.test/'}]), null);
	assert.equal(resolveSyncLocation('C:\\Sync\\map.drawio', [{MountPoint: 'C:\\Sync', UrlNamespace: 'https://user:pass@example.sharepoint.com/'}]), null);
});

test('maps files at a library root and tolerates registry trailing separators', () =>
{
	const location = resolveSyncLocation('C:\\Sync\\map.drawio', [null,
		{MountPoint: 'C:\\Sync\\', UrlNamespace: 'https://example.sharepoint.com/sites/IT/Shared%20Documents/'}]);
	assert.equal(location.folderUrl, 'https://example.sharepoint.com/sites/IT/Shared%20Documents/');
	assert.equal(location.fileUrl, location.folderUrl + 'map.drawio');
});

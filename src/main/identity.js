import {execFile} from 'node:child_process';
import {userInfo} from 'node:os';
import {getSystem32Path} from './system-path.js';

// People are labelled like Office co-authors: the signed-in Windows work or school
// account (UPN) and the Office user name, falling back to the local account.
export function parseRegistryString(output, name)
{
	const match = new RegExp('^\\s*' + name + '\\s+REG_(?:EXPAND_)?SZ\\s+(.*)$', 'mi').exec(output || '');
	return match ? match[1].trim() : '';
}
export function validEmail(value)
{
	return typeof value === 'string' && value.length <= 200 && /^[^\s@<>"']+@[^\s@<>"']+\.[A-Za-z]{2,}$/.test(value);
}
export function nameFromEmail(email)
{
	return email.split('@')[0].split(/[._-]+/).filter(Boolean).map(part => part[0].toUpperCase() + part.slice(1)).join(' ');
}
function run(file, args)
{
	return new Promise(resolve => execFile(file, args, {windowsHide: true, timeout: 5000}, (error, stdout) => resolve(error ? '' : String(stdout))));
}
export async function systemIdentity({platform = process.platform, exec = run, username = userInfo().username} = {})
{
	let email = '';
	let office = '';
	if (platform === 'win32')
	{
		const upn = (await exec(getSystem32Path('whoami.exe'), ['/upn'])).trim();
		email = validEmail(upn) ? upn.toLowerCase() : '';
		office = parseRegistryString(await exec(getSystem32Path('reg.exe'),
			['query', 'HKCU\\Software\\Microsoft\\Office\\Common\\UserInfo', '/v', 'UserName']), 'UserName');
	}
	const name = (office || (email && nameFromEmail(email)) || username || 'Editor').replace(/[\x00-\x1f]/g, '').slice(0, 80);
	return {name, email};
}

import {test} from 'node:test';
import assert from 'node:assert/strict';
import versions from '../shared/version-history.cjs';

const minute = 60 * 1000;
const op = (id, time, name) => ({id, time, name});

test('edits group into AutoSave-style versions after an idle gap, with each editor listed once', () =>
{
	const start = Date.UTC(2026, 9, 29, 9);
	const ready = [op('a', start, 'Alice'), op('b', start + minute, 'Bob'), op('c', start + 2 * minute, 'Alice'),
		op('d', start + 20 * minute, 'Bob')];
	assert.deepEqual(versions.group(ready, {}, start - minute), [
		{index: -1, start: start - minute, end: start - minute, names: [], edits: 0},
		{index: 2, start, end: start + 2 * minute, names: ['Alice', 'Bob'], edits: 3},
		{index: 3, start: start + 20 * minute, end: start + 20 * minute, names: ['Bob'], edits: 1}]);
});

test('continuous editing is split so a long session still has restorable points', () =>
{
	const start = Date.UTC(2026, 9, 29, 9);
	const ready = Array.from({length: 40}, (_, index) => op(String(index), start + index * 2 * minute, 'Alice'));
	const result = versions.group(ready);
	assert.equal(result[0].index, -1);
	assert.equal(result.length > 2, true);
	assert.equal(result.slice(1).every(version => version.end - version.start <= versions.span), true);
	assert.equal(result.at(-1).index, 39, 'the newest version is the current map');
});

test('edits saved before records carried a time use the server times, and undated history yields no versions', () =>
{
	const start = Date.UTC(2026, 9, 29, 9);
	const result = versions.group([{id: 'old', name: 'Alice'}, op('new', start + 30 * minute, 'Bob')], {old: start});
	assert.deepEqual(result.map(version => version.index), [-1, 0, 1]);
	assert.deepEqual(versions.group([{id: 'old', name: 'Alice'}]), []);
});

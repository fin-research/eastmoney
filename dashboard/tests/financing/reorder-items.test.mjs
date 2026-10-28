import test from 'node:test';
import assert from 'node:assert/strict';
import {
	hasSameOrder,
	isCompleteReorder,
	reorderByOffset,
	reorderRelative
} from '../../src/lib/financing/reorder-items.js';

const rows = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
const id = (row) => row.id;

test('reorderRelative moves a node before or after a drop target', () => {
	assert.deepEqual(reorderRelative(rows, id, 'a', 'c', 'before').map(id), ['b', 'a', 'c', 'd']);
	assert.deepEqual(reorderRelative(rows, id, 'a', 'c', 'after').map(id), ['b', 'c', 'a', 'd']);
	assert.deepEqual(rows.map(id), ['a', 'b', 'c', 'd']);
});

test('reorderByOffset supports bounded keyboard movement', () => {
	assert.deepEqual(reorderByOffset(rows, id, 'c', -1).map(id), ['a', 'c', 'b', 'd']);
	assert.deepEqual(reorderByOffset(rows, id, 'a', -1).map(id), ['a', 'b', 'c', 'd']);
	assert.deepEqual(reorderByOffset(rows, id, 'd', 1).map(id), ['a', 'b', 'c', 'd']);
});

test('isCompleteReorder rejects missing, duplicate, and unknown node ids', () => {
	assert.equal(isCompleteReorder(['a', 'b', 'c'], ['c', 'a', 'b']), true);
	assert.equal(isCompleteReorder(['a', 'b', 'c'], ['a', 'b']), false);
	assert.equal(isCompleteReorder(['a', 'b', 'c'], ['a', 'a', 'c']), false);
	assert.equal(isCompleteReorder(['a', 'b', 'c'], ['a', 'b', 'x']), false);
	assert.equal(hasSameOrder(['a', 'b'], ['a', 'b']), true);
	assert.equal(hasSameOrder(['a', 'b'], ['b', 'a']), false);
});

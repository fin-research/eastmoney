/**
 * Return a reordered copy without mutating the source array.
 * The target position is interpreted after the source item is removed.
 *
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} getId
 * @param {string} sourceId
 * @param {string} targetId
 * @param {'before' | 'after'} [position]
 * @returns {T[]}
 */
export function reorderRelative(items, getId, sourceId, targetId, position = 'before') {
	if (sourceId === targetId) return [...items];
	const sourceIndex = items.findIndex((item) => getId(item) === sourceId);
	const targetIndex = items.findIndex((item) => getId(item) === targetId);
	if (sourceIndex < 0 || targetIndex < 0) return [...items];

	const reordered = [...items];
	const [source] = reordered.splice(sourceIndex, 1);
	if (source === undefined) return [...items];
	const adjustedTarget = reordered.findIndex((item) => getId(item) === targetId);
	reordered.splice(adjustedTarget + (position === 'after' ? 1 : 0), 0, source);
	return reordered;
}

/**
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} getId
 * @param {string} sourceId
 * @param {number} delta
 * @returns {T[]}
 */
export function reorderByOffset(items, getId, sourceId, delta) {
	const sourceIndex = items.findIndex((item) => getId(item) === sourceId);
	if (sourceIndex < 0) return [...items];
	const targetIndex = Math.max(0, Math.min(items.length - 1, sourceIndex + delta));
	if (targetIndex === sourceIndex) return [...items];
	const reordered = [...items];
	const [source] = reordered.splice(sourceIndex, 1);
	if (source === undefined) return [...items];
	reordered.splice(targetIndex, 0, source);
	return reordered;
}

/**
 * Validate that a proposed order contains every current id exactly once.
 *
 * @param {string[]} currentIds
 * @param {string[]} proposedIds
 */
export function isCompleteReorder(currentIds, proposedIds) {
	if (currentIds.length !== proposedIds.length) return false;
	if (new Set(proposedIds).size !== proposedIds.length) return false;
	const current = new Set(currentIds);
	return proposedIds.every((id) => current.has(id));
}

/** @param {string[]} left @param {string[]} right */
export function hasSameOrder(left, right) {
	return left.length === right.length && left.every((id, index) => id === right[index]);
}

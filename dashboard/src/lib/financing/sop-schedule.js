const MIN_OFFSET = -3650;
const MAX_OFFSET = 3650;

/** @param {unknown} value */
export function isScheduleDate(value) {
	const text = String(value ?? '');
	if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || text.startsWith('0000')) return false;
	const date = new Date(`${text}T00:00:00Z`);
	return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

/** @param {string} date @param {number} offsetDays */
export function offsetDate(date, offsetDays) {
	if (!isScheduleDate(date) || !Number.isInteger(offsetDays)) throw new Error('计划日期无效');
	const result = new Date(Date.parse(`${date}T00:00:00Z`) + offsetDays * 86_400_000).toISOString().slice(0, 10);
	if (!isScheduleDate(result)) throw new Error('节点日期超出支持范围');
	return result;
}

/** @param {FormData} data
 * @returns {{error: string} | {offsetDays: number, startOffsetDays: number | null}}
 */
export function parseSopSchedule(data) {
	const scheduleType = String(data.get('scheduleType') ?? 'point');
	if (!['point', 'period'].includes(scheduleType)) return { error: '请选择时点或时段' };
	const end = String(data.get('offsetDays') ?? '').trim();
	const start = String(data.get('startOffsetDays') ?? '').trim();
	const validOffset = (/** @type {string} */ value) => value !== '' && Number.isInteger(Number(value)) && Number(value) >= MIN_OFFSET && Number(value) <= MAX_OFFSET;
	if (!validOffset(end) || (scheduleType === 'period' && !validOffset(start))) {
		return { error: '相对日期必须是 -3650 至 3650 之间的整数' };
	}
	const offsetDays = Number(end);
	const startOffsetDays = scheduleType === 'period' ? Number(start) : null;
	if (startOffsetDays !== null && startOffsetDays > offsetDays) return { error: '启动时点不能晚于完成时点' };
	return { offsetDays, startOffsetDays };
}

/** @param {FormData} data
 * @returns {{error: string} | {scheduleType: string, plannedStartDate: string | null, dueDate: string | null}}
 */
export function parseTaskSchedule(data) {
	const scheduleType = String(data.get('scheduleType') ?? 'point');
	if (!['point', 'period'].includes(scheduleType)) return { error: '请选择时点或时段' };
	const dueDate = String(data.get('dueDate') ?? '').trim();
	const plannedStartDate = scheduleType === 'period' ? String(data.get('plannedStartDate') ?? '').trim() : '';
	if (dueDate && !isScheduleDate(dueDate)) return { error: '完成日期格式无效' };
	if (scheduleType === 'period') {
		if (!isScheduleDate(plannedStartDate) || !dueDate) return { error: '时段须填写有效的启动日期和完成日期' };
		if (plannedStartDate > dueDate) return { error: '启动时点不能晚于完成时点' };
	}
	return { scheduleType, plannedStartDate: plannedStartDate || null, dueDate: dueDate || null };
}

/** @param {string} anchor @param {{offsetDays: number, startOffsetDays?: number | null}} node */
export function resolveSopSchedule(anchor, node) {
	const dueDate = offsetDate(anchor, Number(node.offsetDays));
	const plannedStartDate = node.startOffsetDays == null ? null : offsetDate(anchor, Number(node.startOffsetDays));
	if (plannedStartDate && plannedStartDate > dueDate) throw new Error('启动时点不能晚于完成时点');
	return { scheduleType: plannedStartDate ? 'period' : 'point', plannedStartDate, dueDate };
}

/** @param {string} anchor @param {Array<{offsetDays: number, startOffsetDays?: number | null}>} nodes */
export function projectStartDate(anchor, nodes) {
	return nodes.reduce((earliest, node) => {
		const schedule = resolveSopSchedule(anchor, node);
		const start = schedule.plannedStartDate ?? schedule.dueDate;
		return start < earliest ? start : earliest;
	}, anchor);
}

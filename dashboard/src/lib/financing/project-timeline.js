const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** @param {unknown} date */
function parseDate(date) {
	if (!ISO_DATE.test(String(date ?? ''))) return null;
	const value = Date.parse(`${date}T00:00:00Z`);
	return Number.isFinite(value) ? value : null;
}

/** @param {number} value */
function isoDate(value) {
	return new Date(value).toISOString().slice(0, 10);
}

/** @param {number} value */
function monthStart(value) {
	const date = new Date(value);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/** @param {number} value */
function nextMonth(value) {
	const date = new Date(value);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

/** @param {number} value */
function quarterStart(value) {
	const date = new Date(value);
	return Date.UTC(date.getUTCFullYear(), Math.floor(date.getUTCMonth() / 3) * 3, 1);
}

/** @param {number} value */
function nextQuarter(value) {
	const date = new Date(value);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 3, 1);
}

/** @param {number} value @param {number} [min] @param {number} [max] */
function clamp(value, min = 0, max = 100) {
	return Math.min(max, Math.max(min, value));
}

/** @param {number} start @param {number} endExclusive @param {'month' | 'quarter'} unit */
function makeBands(start, endExclusive, unit) {
	const bands = [];
	let cursor = unit === 'quarter' ? quarterStart(start) : monthStart(start);
	while (cursor < endExclusive) {
		const boundary = unit === 'quarter' ? nextQuarter(cursor) : nextMonth(cursor);
		const bandStart = Math.max(cursor, start);
		const bandEnd = Math.min(boundary, endExclusive);
		const date = new Date(cursor);
		bands.push({
			key: `${unit}-${isoDate(cursor)}`,
			label: unit === 'quarter'
				? `${date.getUTCFullYear()}年Q${Math.floor(date.getUTCMonth() / 3) + 1}`
				: `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月`,
			widthPct: ((bandEnd - bandStart) / (endExclusive - start)) * 100
		});
		cursor = boundary;
	}
	return bands;
}

/** @param {number} start @param {number} endExclusive */
function makeWeeks(start, endExclusive) {
	const weeks = [];
	let cursor = start;
	while (cursor < endExclusive) {
		const boundary = Math.min(cursor + 7 * DAY_MS, endExclusive);
		const date = new Date(cursor);
		weeks.push({
			key: `week-${isoDate(cursor)}`,
			label: `${date.getUTCMonth() + 1}/${date.getUTCDate()}`,
			widthPct: ((boundary - cursor) / (endExclusive - start)) * 100
		});
		cursor = boundary;
	}
	return weeks;
}

/**
 * Build one timeline that covers today's date and every visible project/task
 * workflow date. The range is rounded to full calendar months so labels and
 * bars share the same stable scale.
 *
 * @param {Array<Record<string, any>>} projects
 * @param {string} today
 */
export function buildProjectTimeline(projects, today) {
	const todayValue = parseDate(today);
	if (todayValue == null) throw new Error(`Invalid timeline date: ${today}`);
	const dates = [todayValue];
	for (const project of projects ?? []) {
		for (const value of [project.plannedStartDate, project.plannedIssueDate]) {
			const parsed = parseDate(value);
			if (parsed != null) dates.push(parsed);
		}
		for (const task of project.tasks ?? []) {
			for (const value of [task.plannedStartDate, task.dueDate]) {
				const parsed = parseDate(value);
				if (parsed != null) dates.push(parsed);
			}
		}
	}

	const startValue = monthStart(Math.min(...dates));
	const endExclusive = nextMonth(monthStart(Math.max(...dates)));
	const timeline = {
		start: isoDate(startValue),
		end: isoDate(endExclusive - DAY_MS),
		months: makeBands(startValue, endExclusive, 'month'),
		quarters: makeBands(startValue, endExclusive, 'quarter'),
		weeks: makeWeeks(startValue, endExclusive),
		todayPct: ((todayValue - startValue) / (endExclusive - startValue)) * 100
	};
	return timeline;
}

/** @param {string | null | undefined} date @param {{ start: string, end: string }} timeline */
export function positionInTimeline(date, timeline) {
	const value = parseDate(date);
	const start = parseDate(timeline.start);
	const end = parseDate(timeline.end);
	if (value == null || start == null || end == null) return 0;
	return clamp(((value - start) / (end + DAY_MS - start)) * 100);
}

/**
 * @param {string | null | undefined} startDate
 * @param {string | null | undefined} endDate
 * @param {{ start: string, end: string }} timeline
 * @param {number} minimumPct
 */
export function widthInTimeline(startDate, endDate, timeline, minimumPct = 1.5) {
	const startPct = positionInTimeline(startDate, timeline);
	const start = parseDate(startDate);
	const end = parseDate(endDate);
	const timelineStart = parseDate(timeline.start);
	const timelineEnd = parseDate(timeline.end);
	if (start == null || end == null || timelineStart == null || timelineEnd == null) return minimumPct;
	const endPct = clamp(((Math.max(start, end) + DAY_MS - timelineStart) / (timelineEnd + DAY_MS - timelineStart)) * 100);
	return clamp(Math.max(endPct - startPct, minimumPct), minimumPct, 100 - startPct);
}

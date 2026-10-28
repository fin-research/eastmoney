export const MAX_REMINDER_PERIODS = 20;
export const MAX_REMINDER_DAYS = 3650;

/**
 * @param {unknown[]} daysValues
 * @param {unknown[]} hoursValues
 */
export function parseReminderPeriods(daysValues, hoursValues) {
	if (!Array.isArray(daysValues) || !Array.isArray(hoursValues) || daysValues.length !== hoursValues.length) {
		return { error: '提醒周期参数无效' };
	}
	if (!daysValues.length || daysValues.length > MAX_REMINDER_PERIODS) {
		return { error: `请配置 1–${MAX_REMINDER_PERIODS} 个提醒周期` };
	}

	const periods = [];
	const leadHours = new Set();
	for (let index = 0; index < daysValues.length; index += 1) {
		const days = Number(daysValues[index]);
		const hours = Number(hoursValues[index]);
		if (!Number.isInteger(days) || days < 0 || days > MAX_REMINDER_DAYS) {
			return { error: `第 ${index + 1} 个周期的天数应为 0–${MAX_REMINDER_DAYS} 之间的整数` };
		}
		if (!Number.isInteger(hours) || hours < 0 || hours > 23) {
			return { error: `第 ${index + 1} 个周期的小时应为 0–23 之间的整数` };
		}
		const totalHours = days * 24 + hours;
		if (leadHours.has(totalHours)) return { error: '提醒周期不能重复' };
		leadHours.add(totalHours);
		periods.push({ days, hours, leadHours: totalHours, sortOrder: index + 1 });
	}
	return { periods };
}

/** @param {unknown} leadHours */
export function reminderPeriodLabel(leadHours) {
	const total = Number(leadHours);
	if (!Number.isInteger(total) || total < 0) return '未知周期';
	const days = Math.floor(total / 24);
	const hours = total % 24;
	if (hours === 0) return days === 0 ? '节点到期日（09:00）' : `提前 ${days} 天（09:00）`;
	return `提前 ${days ? `${days} 天 ` : ''}${hours} 小时`;
}

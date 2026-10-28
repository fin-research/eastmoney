import { z } from 'zod';
import { isScheduleDate } from './sop-schedule.js';

/** Shared create-form validation; database lookups stay in the named action. */
export const projectCreateSchema = z.object({
  name: z.string().trim().min(1, '项目名称须为 1–160 个字符').max(160, '项目名称须为 1–160 个字符'),
  sopTemplateId: z.string().trim().min(1, '请选择融资品种和对应 SOP'),
  amountYi: z.string().trim().default('').refine(value => !value || /^\d+(?:\.\d{1,8})?$/.test(value), '项目规模须为有效的非负亿元数值'),
  ownerId: z.string().trim().default(''),
  notes: z.string().trim().max(4000, '项目说明不能超过 4,000 个字符').default(''),
  plannedBookbuildingDate: z.string().trim().refine(isScheduleDate, '请填写有效的计划簿记日期'),
});

import { z } from 'zod';
import { pinyin } from 'pinyin-pro';
import Decimal from 'decimal.js';
import type { ShiborRate } from '../../data-contracts.ts';

export const inquiryRowSchema = z.object({
  id: z.string().min(1).max(80), counterparty: z.string().max(160), trader: z.string().max(80),
  tenor: z.string().max(24), amount: z.string().max(24), price: z.string().max(24),
}).strict();
export type InquiryRow = z.infer<typeof inquiryRowSchema>;
export type InquiryField = Exclude<keyof InquiryRow, 'id'>;
export const directorySchema = z.object({ counterparties: z.array(z.string().max(160)).max(1000), traders: z.array(z.string().max(80)).max(1000) });
export type InquiryDirectory = z.infer<typeof directorySchema>;
export const blankDirectory = (): InquiryDirectory => ({ counterparties: [], traders: [] });
export const directoryKey = (actor: string) => `eastmoney:inquiry-directory:v1:${encodeURIComponent(actor)}`;
export const blankInquiry = (): InquiryRow => ({ id: crypto.randomUUID(), counterparty: '', trader: '', tenor: '', amount: '', price: '' });
export function remember(directory: InquiryDirectory, row: InquiryRow): InquiryDirectory {
  const add = (items: string[], value: string) => value.trim() ? [value.trim(), ...items.filter(item => item !== value.trim())].slice(0, 1000) : items;
  return { counterparties: add(directory.counterparties, row.counterparty), traders: add(directory.traders, row.trader) };
}
const normalized = (value: string) => value.toLowerCase().replace(/\s+/g, '');
export function suggestions(values: string[], query: string): string[] {
  const needle = normalized(query);
  return values.map((value, index) => {
    const name = normalized(value), initials = normalized(pinyin(value, { pattern: 'first', toneType: 'none', type: 'array' }).join(''));
    const phonetic = normalized(pinyin(value, { toneType: 'none', type: 'array' }).join(''));
    const score = !needle ? 4 : name === needle ? 0 : name.startsWith(needle) || initials.startsWith(needle) ? 1
      : name.includes(needle) || initials.includes(needle) || phonetic.includes(needle) ? 2
      : [...needle].reduce((at, char) => at < 0 ? -1 : initials.indexOf(char, at) + 1 || -1, 0) > 0 ? 3 : -1;
    return { value, score, index };
  }).filter(item => item.score >= 0).sort((a, b) => a.score - b.score || a.index - b.index).slice(0, 7).map(item => item.value);
}
export const hasInquiryValue = (row: InquiryRow) => [row.counterparty, row.trader, row.tenor, row.amount, row.price].some(value => value.trim());
export function previousValues(rows: InquiryRow[], id: string, field: InquiryField): string[] {
  const index = rows.findIndex(row => row.id === id);
  return [...new Set(rows.slice(0, index).reverse().map(row => row[field]).filter(value => value.trim() && !fieldError(field, value)))].slice(0, 7);
}
export function tenorDays(value: string): number | null {
  const input = value.trim().toUpperCase();
  if (['O/N', 'ON', '隔夜'].includes(input)) return 1;
  const match = /^(\d+(?:\.\d+)?)(D|天|W|周|M|月|Y|年)?$/.exec(input);
  if (!match) return null;
  const days = Number(match[1]) * (({ W: 7, 周: 7, M: 30, 月: 30, Y: 365, 年: 365 } as Record<string, number>)[match[2] ?? 'D'] ?? 1);
  return days > 0 && Number.isSafeInteger(days) ? days : null;
}
const numeric = /^-?\d+(?:\.\d+)?$/;
export function fieldError(field: InquiryField, value: string): string | null {
  if (!value.trim()) return null;
  if (field === 'tenor' && !tenorDays(value)) return '期限须为正整数天数';
  if (field === 'amount' && (!numeric.test(value) || !Number.isFinite(Number(value)) || Number(value) <= 0)) return '金额须为大于零的数值';
  if (field === 'price' && (!numeric.test(value) || !Number.isFinite(Number(value)))) return '价格须为有效数值';
  return null;
}
export function invalidField(row: InquiryRow, loan: boolean): InquiryField | null {
  const fields: InquiryField[] = loan ? ['counterparty', 'trader', 'tenor', 'amount', 'price'] : ['counterparty', 'tenor', 'amount', 'price'];
  return fields.find(field => !row[field].trim() || fieldError(field, row[field])) ?? null;
}
export function shiborTenor(value: string): ShiborRate['tenor'] | null {
  const days = tenorDays(value);
  if (days === null) return null;
  return ([['O/N', 1], ['1W', 7], ['2W', 14], ['1M', 30], ['3M', 90], ['6M', 180], ['9M', 270], ['1Y', 365]] as const).find(([, length]) => length >= days)?.[0] ?? null;
}
export function quotePrice(row: InquiryRow, loan: boolean, rates: ShiborRate[], date: string, now: Date): string {
  if (!numeric.test(row.price)) return row.price;
  if (!loan) return `${new Decimal(row.price).toString()}%`;
  const spread = new Decimal(row.price).abs();
  const base = rates.find(rate => rate.tenor === shiborTenor(row.tenor) && rate.publishDate === date && Date.parse(rate.publishedAt) <= now.getTime());
  return base ? `${new Decimal(base.rate).minus(spread.div(100)).toFixed(4)}%` : `-${spread.toString()}BP`;
}
export function displayField(row: InquiryRow, field: InquiryField, loan: boolean, rates: ShiborRate[], date: string, now: Date): string {
  if (field === 'tenor') return tenorDays(row.tenor) === null ? row.tenor : `${tenorDays(row.tenor)}天`;
  if (field === 'amount') return row.amount ? `${row.amount}亿` : '';
  if (field === 'price') return quotePrice(row, loan, rates, date, now);
  return row[field];
}

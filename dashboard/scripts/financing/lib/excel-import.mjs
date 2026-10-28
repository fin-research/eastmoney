// @ts-nocheck
import { isDebtNarrativeName } from '../../../src/lib/financing/debt-import-rules.js';
import { financingToday } from '../../../src/lib/financing/time.js';
import * as XLSX from 'xlsx/xlsx.mjs';
import { stableDebtKey } from './debt-key.mjs';
import { DEBT_FIELD_COLUMNS } from './debt-fields.mjs';
import { sha256Hex } from './hash.mjs';

// Derived daily movement summary; no independent debt or cashflow records.
const SUMMARY_SHEET_NAMES = new Set(['借入资金汇总表', '变动']);
const SUMMARY_SHEET_NAME = '借入资金汇总表';
const SNAPSHOT_DEBT_TYPES = ['收益凭证', '收益权转让', '同业拆借', '次级债', '集团借款', '转融资', '短期融资券', '私募债', '小公募', '互换便利'];
const FIELD_ALIASES = {
	instrumentName: ['债券简称', '债券名称', '证券简称', '借入资金名称', '品种名称', '债务名称', '项目名称', '名称'],
	instrumentCode: ['债券代码', '证券代码', '合同编码', '代码', '合同编号', '编号'],
	debtType: ['债券类型', '债券种类', '负债品种', '债务品种', '融资品种', '品种', '类别', '类型'],
	borrower: ['发行人', '借款人', '融资主体', '借入单位', '主体', '公司名称'],
	counterparty: ['债权人', '资金出借方', '资金方', '对手方', '交易对手', '认购方', '借款对象', '投资者', '出借人', '拆出方'],
	principalAmount: ['发行金额', '借入金额', '融资金额', '借款金额', '发行规模', '本金', '金额', '规模'],
	outstandingAmount: ['余额', '未偿余额', '剩余本金', '待偿金额'],
	currency: ['币种', '货币'],
	annualRate: ['票面利率', '发行利率', '融资利率', '年利率', '互换利率', '收益率', '利率', '成本'],
	issueDate: ['发行日期', '起息日', '借入日期', '开始日期', '互换开始日', '拆入时间', '到账日期', '交易日期'],
	maturityDate: ['到期日', '兑付日', '截止日期', '结束日期', '互换到期日'],
	status: ['状态', '存续状态'],
	returnType: ['收益类型']
};

function normaliseHeader(value) {
	return String(value ?? '').replace(/[\s\r\n（）()【】\[\]：:，,\-—_]/g, '').toLowerCase();
}

function text(value) {
	if (value === null || value === undefined) return null;
	const result = String(value).trim();
	return result === '' || result === '-' || result === '—' ? null : result;
}

function findHeaderRow(rows) {
	let best = { index: -1, score: 0, fields: {} };
	for (let index = 0; index < Math.min(rows.length, 20); index += 1) {
		const fields = {};
		for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
			const column = rows[index].findIndex((value) => {
				const header = normaliseHeader(value);
				return header && !(field === 'outstandingAmount' && header.includes('日均余额'))
					&& aliases.some((alias) => header.includes(normaliseHeader(alias)));
			});
			if (column >= 0) fields[field] = column;
		}
		const score = Object.keys(fields).length;
		if (score > best.score) best = { index, score, fields };
	}
	return best.score >= 2 ? best : null;
}

function dateValue(value) {
	const candidate = text(value);
	if (!candidate) return null;
	const yearFirstMatch = candidate.match(/^(\d{4})[./年-](\d{1,2})[./月-](\d{1,2})/);
	const monthFirstMatch = candidate.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
	if (!yearFirstMatch && !monthFirstMatch) return null;
	const [, first, second, third] = yearFirstMatch ?? monthFirstMatch;
	const [year, month, day] = yearFirstMatch
		? [first, second, third]
		: [third.length === 2 ? String(2000 + Number(third)) : third, first, second];
	const result = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
	return Number.isNaN(Date.parse(`${result}T00:00:00Z`)) ? null : result;
}

function numericValue(value) {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	const candidate = text(value);
	if (!candidate) return null;
	const number = Number(candidate.replace(/[,，\s]/g, '').replace(/[%％]/g, ''));
	return Number.isFinite(number) ? number : null;
}

function amountValue(value, header) {
	const amount = numericValue(value);
	if (amount === null) return null;
	const normalised = normaliseHeader(header);
	if (normalised.includes('亿元') || normalised.includes('亿')) return amount * 100_000_000;
	if (normalised.includes('万元') || normalised.includes('万')) return amount * 10_000;
	return amount;
}

function rateValue(value) {
	const rate = numericValue(value);
	if (rate === null) return null;
	return /[%％]/.test(String(value)) || rate > 1 ? rate / 100 : rate;
}

function dateFromExcelCell(cell) {
	if (!cell) return null;
	if (typeof cell.v === 'number') {
		const parsed = XLSX.SSF.parse_date_code(cell.v);
		if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
	}
	return dateValue(cell.w ?? cell.v);
}

function dateFromFilename(sourceFile) {
	const match = sourceFile.match(/(20\d{2})(\d{2})(\d{2})/);
	return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function cellValue(sheet, row, column) {
	return sheet[XLSX.utils.encode_cell({ r: row, c: column })];
}

function parseSummaryHistory(workbook, sourceFile) {
	const sheet = workbook.Sheets[SUMMARY_SHEET_NAME];
	if (!sheet) return { snapshots: [], latest: null, excludedFutureDates: [] };
	const sourceDate = dateFromFilename(sourceFile);
	const usedRange = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1');
	const dateColumns = [];
	for (let column = 0; column <= usedRange.e.c; column += 1) {
		const asOfDate = dateFromExcelCell(cellValue(sheet, 2, column));
		if (asOfDate) dateColumns.push({ column, asOfDate });
	}
	const includedColumns = sourceDate
		? dateColumns.filter((candidate) => candidate.asOfDate <= sourceDate)
		: dateColumns;
	const excludedFutureDates = sourceDate
		? dateColumns.filter((candidate) => candidate.asOfDate > sourceDate).map((candidate) => candidate.asOfDate)
		: [];
	const snapshotsByDate = new Map();
	for (const target of includedColumns) {
		const balances = SNAPSHOT_DEBT_TYPES.map((debtType, index) => {
			const row = index + 3;
			const sourceCell = XLSX.utils.encode_cell({ r: row, c: target.column });
			const cell = cellValue(sheet, row, target.column);
			const balanceYi = numericValue(cell?.v);
			if (balanceYi === null) throw new Error(`汇总表 ${sourceCell} 缺少 ${debtType} 余额`);
			return { debtType, balanceYi, sourceCell };
		});
		const totalCell = XLSX.utils.encode_cell({ r: 13, c: target.column });
		const totalYi = numericValue(cellValue(sheet, 13, target.column)?.v);
		if (totalYi === null) throw new Error(`汇总表 ${totalCell} 缺少合计余额`);
		const calculatedTotalYi = balances.reduce((sum, item) => sum + item.balanceYi, 0);
		if (Math.abs(calculatedTotalYi - totalYi) > 1e-8) {
			throw new Error(`汇总表 ${totalCell} 合计不一致：明细 ${calculatedTotalYi}，单元格 ${totalYi}`);
		}
		snapshotsByDate.set(target.asOfDate, {
			asOfDate: target.asOfDate,
			balances,
			totalYi,
			sourceSheet: SUMMARY_SHEET_NAME,
			totalCell,
			sourceSequence: target.column
		});
	}
	// Some workbooks contain the same historical date in adjacent columns;
	// the rightmost occurrence is the later workbook revision.
	const snapshots = [...snapshotsByDate.values()];
	const latest = sourceDate
		? snapshots.find((snapshot) => snapshot.asOfDate === sourceDate)
		: snapshots.at(-1);
	if (!latest) {
		throw new Error(sourceDate
			? `汇总表缺少来源文件基准日 ${sourceDate}`
			: '汇总表未找到可导入日期');
	}
	return { snapshots, latest, excludedFutureDates };
}

export function assertDebtBalanceSnapshot(snapshot) {
	if (!snapshot) throw new Error('未找到可核对的负债余额快照');
	if (typeof snapshot.asOfDate !== 'string' || snapshot.asOfDate.length !== 10) {
		throw new Error('负债余额快照缺少有效基准日');
	}
	if (!Number.isFinite(snapshot.totalYi) || snapshot.totalYi < 0) {
		throw new Error('负债余额快照缺少有效汇总余额');
	}
	if (!Array.isArray(snapshot.balances) || snapshot.balances.length !== SNAPSHOT_DEBT_TYPES.length) {
		throw new Error('负债余额快照的品种余额数量不完整');
	}
	const seenDebtTypes = new Set();
	for (const balance of snapshot.balances) {
		if (!SNAPSHOT_DEBT_TYPES.includes(balance?.debtType) || seenDebtTypes.has(balance.debtType)) {
			throw new Error('负债余额快照包含未知或重复的负债品种');
		}
		if (!Number.isFinite(balance.balanceYi) || balance.balanceYi < 0) {
			throw new Error('负债余额快照包含无效品种余额');
		}
		seenDebtTypes.add(balance.debtType);
	}
	const calculatedTotalYi = snapshot.balances.reduce((sum, item) => sum + item.balanceYi, 0);
	if (Math.abs(calculatedTotalYi - snapshot.totalYi) > 1e-8) {
		throw new Error('负债余额快照的明细合计与汇总余额不一致');
	}
	return { asOfDate: snapshot.asOfDate, totalYi: snapshot.totalYi, balances: snapshot.balances };
}
function mapStatus(value, maturityDate) {
	const candidate = text(value)?.toLowerCase() ?? '';
	if (/未到期|存续/.test(candidate)) return 'active';
	if (/发行失败|作废|取消/.test(candidate)) return 'closed';
	if (/已到期|已兑付|兑付完毕/.test(candidate)) return 'matured';
	if (/计划|拟/.test(candidate)) return 'planned';
	if (/结束|注销|终止|偿还/.test(candidate)) return 'closed';
	if (maturityDate && maturityDate < financingToday()) return 'matured';
	return 'active';
}

function debtCategories(sheetName, row, fields) {
	if (sheetName === '收益凭证') {
		const returnType = String(valueAt(row, fields, 'returnType') ?? '');
		return {
			categoryLevel1: '收益凭证',
			categoryLevel2: returnType.includes('浮动') ? '浮动收益凭证' : '固定收益凭证'
		};
	}
	if (['小公募', '次级债', '私募债', '科创债', '短期融资券', '公司债'].includes(sheetName)) {
		return { categoryLevel1: '债券', categoryLevel2: sheetName };
	}
	return { categoryLevel1: sheetName, categoryLevel2: null };
}

function valueAt(row, fields, field) {
	const index = fields[field];
	return index === undefined ? null : row[index];
}

function isUsableRow(row, fields) {
	const values = Object.values(fields).map((index) => text(row[index])).filter(Boolean);
	if (values.length === 0) return false;
	return !values.every((value) => /^(合计|总计|小计|备注|说明)$/u.test(value));
}

function isMeaningfulRow(row) {
	return row.some((value) => text(value) !== null);
}

function isNarrativeRow(row, sheetName, fields, headers) {
 if (!['小公募', '次级债', '私募债', '科创债', '短期融资券', '公司债', '集团借款'].includes(sheetName)) return false;
 const names = ['instrumentName', 'counterparty'].map(field => text(valueAt(row, fields, field))).filter(Boolean);
 if (!names.some(isDebtNarrativeName)) return false;
 if (['issueDate', 'maturityDate', 'annualRate', 'instrumentCode'].some(field => text(valueAt(row, fields, field)) !== null)) return false;
 if (!['principalAmount', 'outstandingAmount'].every(field => isZeroOrMissingAmount(valueAt(row, fields, field), headers[fields[field]]))) return false;
 // Extra business dates or cashflows must be validated, never silently discarded.
 return row.every((value, index) => {
  const candidate = text(value);
  return candidate === null || isDebtNarrativeName(candidate) || /^(?:0(?:\.0+)?|[-—–])$/u.test(candidate);
 });
}

function isZeroOrMissingAmount(value, header) {
	const amount = amountValue(value, header);
	return amount === null || amount === 0;
}

function meaningfulSheetBounds(sheet) {
	let maxRow = -1;
	let maxColumn = -1;
	for (const [address, cell] of Object.entries(sheet)) {
		if (address.startsWith('!') || text(cell?.v) === null) continue;
		const position = XLSX.utils.decode_cell(address);
		maxRow = Math.max(maxRow, position.r);
		maxColumn = Math.max(maxColumn, position.c);
	}
	return { maxRow, maxColumn };
}

const DATE_FIELD_HEADERS = [
	'日期', '认购日', '簿记日', '发行日', '起息日', '到期日', '兑付日',
	'还息日', '偿还日', '付息时间', '计息期间', '拆入时间', '开始日', '结束日'
];

function fieldValuesForRow(sheet, sourceRow, headers, maxColumn) {
	const cells = [];
	for (let column = 0; column <= maxColumn; column += 1) {
		const address = XLSX.utils.encode_cell({ r: sourceRow - 1, c: column });
		const cell = sheet[address];
		if (!cell || text(cell.v) === null) continue;
		const fieldName = text(headers[column]) ?? `未命名字段 ${column + 1}`;
		const isDateField = DATE_FIELD_HEADERS.some((candidate) =>
			normaliseHeader(fieldName).includes(normaliseHeader(candidate))
		);
		cells.push({
			fieldOrder: column,
			fieldName,
			displayValue: String(cell.w ?? cell.v),
			numericValue: typeof cell.v === 'number' && Number.isFinite(cell.v) ? cell.v : null,
			dateValue: isDateField ? dateFromExcelCell(cell) : null
		});
	}
	return cells;
}

function stableId(value) {
	return sha256Hex(value);
}

const CASHFLOW_DATE_HEADERS = ['还息日', '偿还日', '付息时间', '还息计划', '计息期间', '到期日'];
const INTEREST_AMOUNT_HEADERS = ['应付利息', '偿还利息'];
const PRINCIPAL_AMOUNT_HEADERS = ['偿还本金'];

function cashflowEventsForRow({
	row,
	headers,
	sheetName,
	sourceRow,
	debtId,
	externalKey,
	sequenceForEvent
}) {
	const dateColumns = headers
		.map((header, column) => ({ column, header: normaliseHeader(header), date: dateValue(row[column]) }))
		.filter((item) =>
			item.date
			&& CASHFLOW_DATE_HEADERS.some((candidate) => item.header.includes(normaliseHeader(candidate)))
		);
	const amountColumns = headers
		.map((header, column) => ({ column, header: normaliseHeader(header) }))
		.filter((item) => {
			if (
				sheetName === '收益权转让'
				&& INTEREST_AMOUNT_HEADERS.some((candidate) => item.header.includes(normaliseHeader(candidate)))
			) return false;
			return [...INTEREST_AMOUNT_HEADERS, ...PRINCIPAL_AMOUNT_HEADERS]
				.some((candidate) => item.header.includes(normaliseHeader(candidate)));
		});

	if (sheetName === '收益权转让') {
		for (const dateColumn of dateColumns.filter((item) => item.header.includes('还息计划'))) {
			amountColumns.push({ column: dateColumn.column + 1, header: normaliseHeader('应付利息') });
		}
	}

	const events = [];
	for (const amountColumn of amountColumns) {
		const amount = amountValue(row[amountColumn.column], headers[amountColumn.column]);
		if (amount === null && text(row[amountColumn.column]) !== null) throw new Error(`工作表 ${sheetName} 第 ${sourceRow} 行的现金流金额无效`);
		if (amount === null || amount === 0) continue;
		if (!dateColumns.length) throw new Error(`工作表 ${sheetName} 第 ${sourceRow} 行有现金流金额但缺少有效日期`);
		const dateColumn = [...dateColumns].sort(
			(left, right) =>
				Math.abs(left.column - amountColumn.column) - Math.abs(right.column - amountColumn.column)
		)[0];
		const eventType = PRINCIPAL_AMOUNT_HEADERS.some((candidate) =>
			amountColumn.header.includes(normaliseHeader(candidate))
		) ? 'principal' : 'interest';
		const sequence = sequenceForEvent(eventType, dateColumn.date, amount);
		const eventKey = stableId([externalKey, eventType, dateColumn.date, amount, sequence].join(':'));
		events.push({
			eventKey,
			debtId,
			eventType,
			eventDate: dateColumn.date,
			amount,
			sequence
		});
	}
	return events;
}

function rowToDebt(row, fields, sheetName, headers) {
	const instrumentName = text(valueAt(row, fields, 'instrumentName'));
	const instrumentCode = text(valueAt(row, fields, 'instrumentCode'));
	const principalAmount = amountValue(valueAt(row, fields, 'principalAmount'), headers[fields.principalAmount]);
	const outstandingAmount = amountValue(valueAt(row, fields, 'outstandingAmount'), headers[fields.outstandingAmount]);
	const maturityDate = dateValue(valueAt(row, fields, 'maturityDate'));
  for (const field of ['principalAmount','outstandingAmount','annualRate','issueDate','maturityDate']) {
    const raw=valueAt(row,fields,field);
    if(text(raw)===null)continue;
    const parsed=field.endsWith('Date')?dateValue(raw):field==='annualRate'?rateValue(raw):amountValue(raw,headers[fields[field]]);
    if(parsed===null || (field.endsWith('Date') && new Date(`${parsed}T00:00:00Z`).toISOString().slice(0,10)!==parsed))throw new Error(`工作表 ${sheetName} 的 ${headers[fields[field]]} 无效：${raw}`);
  }
	return {
		id: globalThis.crypto.randomUUID(),
		debtType: sheetName,
		...debtCategories(sheetName, row, fields),
		instrumentName,
		instrumentCode,
		borrower: text(valueAt(row, fields, 'borrower')),
		counterparty: text(valueAt(row, fields, 'counterparty')),
		principalAmount,
		outstandingAmount: outstandingAmount ?? principalAmount,
		currency: text(valueAt(row, fields, 'currency')) ?? 'CNY',
		annualRate: rateValue(valueAt(row, fields, 'annualRate')),
		issueDate: dateValue(valueAt(row, fields, 'issueDate')),
		maturityDate,
		status: mapStatus(valueAt(row, fields, 'status'), maturityDate)
	};
}

export function parseDebtWorkbookData(workbookData, sourceFile) {
	const workbook = XLSX.read(workbookData, { type: 'array', cellDates: false });
	const history = parseSummaryHistory(workbook, sourceFile);
	const debts = [];
	const definitions = new Map();
	const recordGroups = [];
	const cashflows = [];
	const workbookNotes = new Map();
	const keyOccurrences = new Map();
	let sheetCount = 0;
	let skipped = 0;
	let fieldValueCount = 0;
	const warnings = [];
	let skippedFailedIssues = 0;
	let skippedNarrativeRows = 0;

	for (const sheetName of workbook.SheetNames) {
		if (SUMMARY_SHEET_NAMES.has(sheetName)) continue;
		const sheet = workbook.Sheets[sheetName];
		const bounds = meaningfulSheetBounds(sheet);
		if (bounds.maxRow < 0 || bounds.maxColumn < 0) continue;
		if (bounds.maxColumn >= DEBT_FIELD_COLUMNS.length) {
			throw new Error(`工作表 ${sheetName} 字段超过 ${DEBT_FIELD_COLUMNS.length} 列上限`);
		}
		const rows = XLSX.utils.sheet_to_json(sheet, {
			header: 1,
			range: {
				s: { r: 0, c: 0 },
				e: { r: bounds.maxRow, c: bounds.maxColumn }
			},
			raw: false,
			defval: null,
			blankrows: true
		});
		const header = findHeaderRow(rows);
		if (!header) throw new Error(`工作表 ${sheetName} 无法识别表头`);
		sheetCount += 1;
		const headers = rows[header.index];
		const averageRepoBalanceColumn = sheetName === '互换便利'
			? headers.findIndex((value) => normaliseHeader(value).includes('正回购日均余额'))
			: -1;
		const issueStatusColumn = sheetName === '收益凭证'
			? headers.findIndex((value) => normaliseHeader(value) === '发行状态')
			: -1;
		let parent = null;

		for (let index = header.index + 1; index < rows.length; index += 1) {
			const row = rows[index];
			if (!isMeaningfulRow(row)) continue;
			const sourceRow = index + 1;
			if (isNarrativeRow(row, sheetName, header.fields, headers)) {
				parent = null;
				skippedNarrativeRows += 1;
				skipped += 1;
				continue;
			}
			if (issueStatusColumn >= 0 && text(row[issueStatusColumn]) === '发行失败'
				&& isZeroOrMissingAmount(valueAt(row, header.fields, 'principalAmount'), headers[header.fields.principalAmount])
				&& isZeroOrMissingAmount(valueAt(row, header.fields, 'outstandingAmount'), headers[header.fields.outstandingAmount])) {
				skippedFailedIssues += 1;
				skipped += 1;
				continue;
			}
			if (isUsableRow(row, header.fields)) {
				const candidate = rowToDebt(row, header.fields, sheetName, headers);
				if (
					candidate.instrumentName
					|| candidate.instrumentCode
					|| candidate.counterparty
					|| candidate.principalAmount !== null
				) {
					if (averageRepoBalanceColumn >= 0 && text(row[averageRepoBalanceColumn]) !== null
						&& numericValue(row[averageRepoBalanceColumn]) === null) {
						warnings.push(`工作表 ${sheetName} 第 ${sourceRow} 行的正回购日均余额为文字说明，已跳过数值校验并保留说明`);
					}
					const occurrenceBase = stableDebtKey(candidate, 0);
					const occurrence = keyOccurrences.get(occurrenceBase) ?? 0;
					keyOccurrences.set(occurrenceBase, occurrence + 1);
					candidate.externalKey = stableDebtKey(candidate, occurrence);
					debts.push([
						candidate.id,
						candidate.externalKey,
						candidate.debtType,
						candidate.categoryLevel1,
						candidate.categoryLevel2,
						candidate.instrumentName,
						candidate.instrumentCode,
						candidate.borrower,
						candidate.counterparty,
						candidate.principalAmount,
						candidate.outstandingAmount,
						candidate.currency,
						candidate.annualRate,
						candidate.issueDate,
						candidate.maturityDate,
						candidate.status
					]);
					const group = [candidate.externalKey, []];
					recordGroups.push(group);
					parent = {
						debtId: candidate.id,
						externalKey: candidate.externalKey,
						rowSequence: 0,
						eventSequences: new Map(),
						group
					};
				}
			}

			if (!parent) {
				if(row.filter(value=>text(value)!==null).every(value=>/^(合计|总计|小计|备注|说明)([：:].*)?$/u.test(String(value)))){skipped+=1;continue;}
				throw new Error(`工作表 ${sheetName} 第 ${sourceRow} 行无法关联负债`);
			}
			const values = Array(DEBT_FIELD_COLUMNS.length).fill(null);
			for (const field of fieldValuesForRow(sheet, sourceRow, headers, bounds.maxColumn)) {
				if (field.fieldName.startsWith('未命名字段') && /^(注|说明)[：:.、\s]/u.test(field.displayValue)) {
					workbookNotes.set(sheetName, [sheetName, field.displayValue]);
					fieldValueCount += 1;
					continue;
				}
				definitions.set(`${sheetName}:${field.fieldOrder}`, [sheetName, field.fieldOrder, field.fieldName]);
				values[field.fieldOrder] = field.displayValue;
				fieldValueCount += 1;
			}
			parent.group[1].push([parent.rowSequence, values]);

			const events = cashflowEventsForRow({
				row,
				headers,
				sheetName,
				sourceRow,
				debtId: parent.debtId,
				externalKey: parent.externalKey,
				sequenceForEvent: (eventType, eventDate, amount) => {
					const key = `${eventType}:${eventDate}:${amount}`;
					const sequence = parent.eventSequences.get(key) ?? 0;
					parent.eventSequences.set(key, sequence + 1);
					return sequence;
				}
			});
			for (const event of events) {
				cashflows.push([
					event.eventKey,
					parent.externalKey,
					event.eventType,
					event.eventDate,
					event.amount,
					event.sequence
				]);
			}
			parent.rowSequence += 1;
		}
	}

	const balances = history.snapshots.flatMap((snapshot) => snapshot.balances.map((balance) => [
		snapshot.asOfDate,
		balance.debtType,
		balance.balanceYi
	]));
	if (skippedFailedIssues) warnings.push(`已跳过 ${skippedFailedIssues} 条发行失败且无金额的收益凭证记录`);
	if (skippedNarrativeRows) warnings.push(`已跳过 ${skippedNarrativeRows} 行债券及集团借款说明文字`);
	if (skipped > skippedFailedIssues + skippedNarrativeRows) {
		warnings.push(`已跳过 ${skipped - skippedFailedIssues - skippedNarrativeRows} 行无独立负债的汇总说明`);
	}
	return {
		debts,
		definitions: [...definitions.values()],
		recordGroups,
		cashflows,
		workbookNotes: [...workbookNotes.values()],
		balances,
		fieldValueCount,
		sheetCount,
		skipped,
		warnings,
		historyDateCount: new Set(history.snapshots.map((snapshot) => snapshot.asOfDate)).size,
		historyStartDate: history.snapshots[0]?.asOfDate ?? null,
		historyEndDate: history.snapshots.at(-1)?.asOfDate ?? null,
		excludedFutureDates: history.excludedFutureDates,
		snapshot: assertDebtBalanceSnapshot(history.latest)
	};
}

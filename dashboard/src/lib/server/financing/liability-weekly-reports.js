// @ts-nocheck
import { randomUUID } from 'node:crypto';
import { normalizeManualLiabilitySources } from '../../financing/liability-choice.js';
import { LIABILITY_REPORT_EDB_CODES, normalizeLiabilityReportDatabasePayload } from '../../financing/liability-report-data.js';

const SOURCE_FILES = {
	parameters: [
		'底稿/【每月初替换】负债测算/净资本数据.xlsx',
		'底稿/【每月初替换】负债测算/负债测算2026.7.xlsx'
	]
};

const CALIBER = {
	balance: '主动负债余额与结构使用 financing.balance_snapshot；明细台账仅用于实时指标和勾稽提示。',
	activeDebt: '统计日以前已起息且未到期、未关闭的 financing.debt；无到期日记录保留并标记勾稽缺口。',
	cumulativeBorrowing: '月末累计新增借款按已导入余额快照差额计算，并剔除互换便利。',
	projects: '推进中融资计划只读 financing.projects 的 planning/in_progress/at_risk，项目字段缺失不隐藏。',
	dynamics: '近期动态只含实际发行、到期和付息；收益凭证发行日优先取认购日，融资计划不计入动态金额。',
	market: '浏览器通过 Neon Data API 只读 public.edb 白名单原始观测，并按同日券商债与国债收益率之差计算信用利差；Choice EDB 由 dashboard 每日定时增量更新。',
	choice: '用户点击生成后由浏览器直接发起一次 Choice CTR 年初至报告日逻辑请求；周表取报告日所在周周一至报告日，年度图取年初至报告日。',
	registration: '用户点击生成后由浏览器通过统一 Data API 分页读取 DM 券商债券申报；区间为报告日所在周周一至报告日，不使用数据库底稿回退。',
	database: '融资工作台业务数据由浏览器使用短期 JWT 调用 Neon Data API 聚合 RPC；历史月末趋势读取冻结汇总，仅当前报告月份实时计算，financing Worker 只校验并固化快照。',
	due30: '未来30天与年内到期核心指标统计全量已安排负债并纳入尚未发行记录；仅未来30天到期明细排除同业拆借和浮动收益凭证，独立付息现金流不计作负债到期。',
	parameters: '净资本、净资产和资产负债规模读取 financing.financial_monthly_data 月末历史，按报告日期及上月末/上年末口径取最近有效值；两项资产负债率由同月基础数据计算。'
};

function hex(buffer) {
	return [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256(value) {
	return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}


export function getLiabilityWeeklyReportSourceStatus(report, sources = {
	ctr: { status: 'missing', error: '本次尚未手动拉取 Choice CTR。' },
	registration: { status: 'missing', error: '本次尚未手动拉取 DM 券商债券申报。' }
}) {
	const requiredParameters = [
		'prior_month_net_capital', 'securities_prior_year_net_assets', 'group_prior_year_net_assets',
		'total_assets', 'total_liabilities', 'agency_brokerage_funds',
		'asset_liability_ratio', 'adjusted_asset_liability_ratio'
	];
	const marketSeries = new Set((report.marketHistory ?? []).map((item) => item.seriesId));
	const missingMarketSeries = LIABILITY_REPORT_EDB_CODES.filter((code) => !marketSeries.has(code));
	const missingParameterCodes = requiredParameters.filter((code) => report.parameters?.[code]?.valueYi == null);
	const incompleteProjects = (report.projects ?? []).filter((project) =>
		project.expectedRateMin == null || project.expectedRateMax == null || project.fundingCostRate == null
		|| project.tenorDescription == null || project.amountDescription == null
	);
	const peerCount = sources.peerIssuances?.length ?? 0;
	const peerCouponCount = (sources.peerIssuances ?? []).filter((item) => item.couponRatePct != null).length;
	const counts = {
		market_series_count: LIABILITY_REPORT_EDB_CODES.length - missingMarketSeries.length,
		missing_market_series: missingMarketSeries.join(', ') || null,
		market_as_of_date: (report.marketHistory ?? []).reduce((latest, item) => item.observationDate > latest ? item.observationDate : latest, ''),
		peer_count: peerCount,
		peer_coupon_count: peerCouponCount,
		registration_count: sources.registration.status === 'available' ? sources.registration.rows.length : 0,
		parameter_count: requiredParameters.length - missingParameterCodes.length,
		missing_parameter_codes: missingParameterCodes.join(', ') || null,
		missing_maturity_count: report.quality.missingMaturityCount,
		missing_maturity_amount_yi: report.quality.missingMaturityAmountYi,
		missing_maturity_details: report.quality.missingMaturityDetails,
		incomplete_project_count: incompleteProjects.length
	};
	const missingModules = [];
	if (Number(counts.market_series_count ?? 0) < LIABILITY_REPORT_EDB_CODES.length) {
		missingModules.push({
			code: 'market_rates',
			title: 'public.edb 市场利率与信用利差',
			detail: report.quality.marketRateError
				? `原始市场利率读取失败：${report.quality.marketRateError}。本模块已留空，其他周报数据不受影响。`
				: `定时同步数据缺少指标：${counts.missing_market_series ?? '未识别'}。`
		});
	}
	if (sources.ctr.status !== 'available') {
		missingModules.push({ code: 'peer_issuance', title: '可比券商发行明细', detail: sources.ctr.error });
	}
	if (Number(counts.peer_count ?? 0) > Number(counts.peer_coupon_count ?? 0)) {
		missingModules.push({ code: 'peer_coupon_rate', title: '可比券商发行利率', detail: `本周 ${counts.peer_count} 条券商发行中有 ${Number(counts.peer_count) - Number(counts.peer_coupon_count ?? 0)} 条缺少票面利率。` });
	}
	if (sources.registration.status !== 'available') {
		missingModules.push({ code: 'registration_progress', title: '可比券商注册进程', detail: sources.registration.error });
	}
	if (Number(counts.parameter_count ?? 0) < 8) {
		missingModules.push({ code: 'finance_parameters', title: '净资本、净资产与资产负债规模', detail: `生产库缺少参数：${counts.missing_parameter_codes ?? '未识别'}。` });
	}
	if (Number(counts.missing_maturity_count ?? 0) > 0) {
		missingModules.push({
			code: 'debt_maturity',
			title: '负债到期日字段',
			detail: `${counts.missing_maturity_count} 条负债缺少到期日（合计 ${Number(counts.missing_maturity_amount_yi ?? 0).toFixed(4)} 亿元）：${counts.missing_maturity_details ?? '具体记录未识别'}。请确认后补录。`
		});
	}
	if (Number(counts.incomplete_project_count ?? 0) > 0) {
		missingModules.push({ code: 'project_fields', title: '推进中项目字段', detail: `${counts.incomplete_project_count} 个推进中项目缺少预计利率、资金成本、期限描述或规模说明中的一项。` });
	}
	if (report.quality.balanceSnapshotDate !== report.asOfDate) {
		missingModules.push({
			code: 'balance_snapshot_date',
			title: '负债余额快照',
			detail: report.quality.balanceSnapshotDate
				? `最近余额快照为 ${report.quality.balanceSnapshotDate}，与报告日 ${report.asOfDate} 不同日；主动负债余额与结构沿用该快照，不执行跨日明细勾稽。`
				: `报告日 ${report.asOfDate} 之前无可用余额快照，主动负债余额与结构暂无可靠数据。`
		});
	} else if (report.quality.liveDerivedReliable === false) {
		missingModules.push({
			code: 'reconciliation',
			title: '负债明细与余额快照勾稽',
			detail: `明细余额与 ${report.quality.balanceSnapshotDate ?? report.asOfDate} 快照相差 ${Math.abs(report.quality.reconciliationDeltaYi).toFixed(4)} 亿元；保留明细展示，但金额须核对。`
		});
	}
	return { counts, missingModules };
}

export async function getLiabilityWeeklyReportRunByDate(database, asOfDate) {
	// Hyperdrive does not invalidate a cached empty SELECT after snapshot generation.
	// The real-time predicate keeps this read-after-write path outside its query cache.
	return database.prepare(`
		SELECT id, as_of_date AS "asOfDate", generated_at AS "generatedAt",
			generated_by AS "generatedByPersonId", r2_key AS "r2Key",
			content_sha256 AS "contentSha256", status, source_manifest AS "sourceManifest",
			missing_modules AS "missingModules", error_message AS "errorMessage"
		FROM liability_weekly_report_runs
		WHERE as_of_date = ? AND status = 'complete'
			AND updated_at <= CURRENT_TIMESTAMP
		LIMIT 1
	`).get(asOfDate);
}

export async function readLiabilityWeeklyReportSnapshot(env, run) {
	const bucket = env?.LIABILITY_REPORT_SNAPSHOTS;
	if (!bucket) throw new Error('R2 绑定 LIABILITY_REPORT_SNAPSHOTS 不可用');
	const object = await bucket.get(run.r2Key);
	if (!object) throw new Error(`周报快照不存在：${run.r2Key}`);
	return object.json();
}

export async function saveLiabilityWeeklyReportSnapshot({ database, env, actor, databasePayload, sources: submittedSources, expectedAsOfDate }) {
	const bucket = env?.LIABILITY_REPORT_SNAPSHOTS;
	if (!bucket) throw new Error('R2 绑定 LIABILITY_REPORT_SNAPSHOTS 不可用');
	const baseReport = normalizeLiabilityReportDatabasePayload(databasePayload, expectedAsOfDate);
	const asOfDate = expectedAsOfDate;
	const manualSources = normalizeManualLiabilitySources(submittedSources, asOfDate);
	const report = {
		...baseReport,
		peerIssuances: manualSources.peerIssuances,
		peerIssueSummary: manualSources.peerIssueSummary,
		registrationProgress: manualSources.registration.status === 'available' ? manualSources.registration.rows : []
	};
	const sourceStatus = getLiabilityWeeklyReportSourceStatus(report, manualSources);
	const generatedAt = new Date().toISOString();
	const snapshot = {
		version: 5,
		generatedAt,
		asOfDate,
		report,
		sources: manualSources,
		provenance: {
			generation: 'manual',
			choiceQuota: { edbLogicalRequests: 0, ctrLogicalRequests: 1, maxAttemptsPerRequest: 3, requestOrigin: 'browser', window: manualSources.issuanceWindow },
			neonDataApi: {
				business: {
					path: '/rpc/liability_weekly_report_data',
					asOfDate,
					requestOrigin: 'browser',
					aggregation: 'postgres-current-and-cached-closed-months'
				},
				marketRates: {
					path: '/liability_market_rate_observations',
					window: { startDate: `${asOfDate.slice(0, 4)}-01-01`, endDate: asOfDate },
					requestOrigin: 'browser',
					spreadCalculation: 'browser',
					status: report.quality.marketRateError ? 'missing' : 'available',
					error: report.quality.marketRateError
				}
			},
			dmRegistrations: {
				path: '/broker-bond-registrations',
				window: manualSources.weekWindow,
				status: manualSources.registration.status,
				rowCount: manualSources.registration.status === 'available' ? manualSources.registration.rows.length : 0,
				requestOrigin: 'browser'
			},
			databaseSources: {
				marketRates: 'public.edb',
				marketRatesAsOf: sourceStatus.counts.market_as_of_date || null,
				balanceSnapshotDate: report.quality.balanceSnapshotDate
			},
			sourceFiles: SOURCE_FILES,
			caliber: CALIBER,
			sourceCounts: sourceStatus.counts,
			missingModules: sourceStatus.missingModules
		}
	};
	const content = JSON.stringify(snapshot);
	const contentSha256 = await sha256(content);
	const r2Key = `liability-report/${asOfDate}.json`;
	let id;
	let previousRun = null;
	await database.transaction(async (transaction) => {
		previousRun = await transaction.prepare(`
			SELECT id, as_of_date AS "asOfDate", generated_at AS "generatedAt",
				generated_by AS "generatedByPersonId", r2_key AS "r2Key",
				content_sha256 AS "contentSha256", status
			FROM liability_weekly_report_runs
			WHERE as_of_date = ?
			FOR UPDATE
		`).get(asOfDate);
		id = previousRun?.id ?? randomUUID();
		if (previousRun) {
			await transaction.prepare(`
			UPDATE liability_weekly_report_runs
				SET generated_at = CURRENT_TIMESTAMP, generated_by = ?,
					r2_key = ?, content_sha256 = ?, status = 'pending',
					source_manifest = ?::jsonb, missing_modules = ?::jsonb, error_message = NULL,
					updated_at = CURRENT_TIMESTAMP
				WHERE id = ?
			`).run(actor?.personId ?? null, r2Key, contentSha256,
				JSON.stringify(snapshot.provenance), JSON.stringify(sourceStatus.missingModules), id);
		} else {
			await transaction.prepare(`
				INSERT INTO liability_weekly_report_runs (
					id, as_of_date, generated_by, r2_key, content_sha256, status,
					source_manifest, missing_modules
				) VALUES (?, ?, ?, ?, ?, 'pending', ?::jsonb, ?::jsonb)
			`).run(id, asOfDate, actor?.personId ?? null, r2Key, contentSha256,
				JSON.stringify(snapshot.provenance), JSON.stringify(sourceStatus.missingModules));
		}
	});
	try {
		await bucket.put(r2Key, content, {
			httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-cache' },
			customMetadata: { asOfDate, contentSha256, reportRunId: id }
		});
		await database.prepare(`
			UPDATE liability_weekly_report_runs SET status = 'complete', updated_at = CURRENT_TIMESTAMP WHERE id = ?
		`).run(id);
	} catch (error) {
		await database.prepare(`
			UPDATE liability_weekly_report_runs
			SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
			WHERE id = ?
		`).run(String(error?.message ?? error), id);
		throw error;
	}
	return { id, asOfDate, r2Key, contentSha256, missingModules: sourceStatus.missingModules, snapshot };
}

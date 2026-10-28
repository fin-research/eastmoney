BEGIN;

SET LOCAL search_path TO financing, public;

-- Comparable-broker issuance and registration now come from Choice and DM at
-- generation time. The legacy installation-package staging tables are no
-- longer report inputs. The old market staging table was already superseded by
-- the shared public.edb series.
DROP TABLE IF EXISTS liability_peer_issuances;
DROP TABLE IF EXISTS liability_registration_progress;
DROP TABLE IF EXISTS liability_market_observations;

CREATE OR REPLACE FUNCTION liability_weekly_report_data(p_report_date date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, financing, public
AS $$
DECLARE
	result jsonb;
	shanghai_today date := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date;
BEGIN
	IF NOT financing.current_app_user_can_edit() THEN
		RAISE EXCEPTION 'authenticated user is not an active financing person'
			USING ERRCODE = '42501';
	END IF;
	IF p_report_date IS NULL OR p_report_date > shanghai_today THEN
		RAISE EXCEPTION 'report date must not be later than today'
			USING ERRCODE = '22007';
	END IF;

	WITH args AS (
		SELECT p_report_date AS as_of_date, shanghai_today AS today
	), liability_rate_series(series_id, series_name, category, tenor, unit) AS (
		VALUES
			('E1707781', '中债证券公司债到期收益率(AAA-):1年', 'chinabond_broker_aaa_minus_yield', '1年', '%'),
			('E1707782', '中债证券公司债到期收益率(AAA-):2年', 'chinabond_broker_aaa_minus_yield', '2年', '%'),
			('E1707783', '中债证券公司债到期收益率(AAA-):3年', 'chinabond_broker_aaa_minus_yield', '3年', '%'),
			('E1707785', '中债证券公司债到期收益率(AAA-):5年', 'chinabond_broker_aaa_minus_yield', '5年', '%'),
			('E1704284', '同业存单发行利率(国有银行):1年', 'state_owned_bank_ncd', '1年', '%'),
			('E1704283', '同业存单发行利率(国有银行):9个月', 'state_owned_bank_ncd', '9个月', '%'),
			('E1704282', '同业存单发行利率(国有银行):6个月', 'state_owned_bank_ncd', '6个月', '%'),
			('E1704281', '同业存单发行利率(国有银行):3个月', 'state_owned_bank_ncd', '3个月', '%'),
			('E1707781', 'AAA-券商债:1年', 'credit_spread_broker_govt_1y', '1年', '%'),
			('E1000172', '国债:1年', 'credit_spread_broker_govt_1y', '1年', '%'),
			('E1707783', 'AAA-券商债:3年', 'credit_spread_broker_govt_3y', '3年', '%'),
			('E1000174', '国债:3年', 'credit_spread_broker_govt_3y', '3年', '%'),
			('E1707785', 'AAA-券商债:5年', 'credit_spread_broker_govt_5y', '5年', '%'),
			('E1000176', '国债:5年', 'credit_spread_broker_govt_5y', '5年', '%')
	), liability_spread_pairs(category, tenor, broker_series_id, government_series_id) AS (
		VALUES
			('credit_spread_broker_govt_1y', '1年', 'E1707781', 'E1000172'),
			('credit_spread_broker_govt_3y', '3年', 'E1707783', 'E1000174'),
			('credit_spread_broker_govt_5y', '5年', 'E1707785', 'E1000176')
	), latest AS (
		SELECT as_of_date FROM args
	), point_dates AS (
		SELECT 'current'::text AS label, as_of_date FROM latest
		UNION ALL SELECT 'month', date_trunc('month', as_of_date)::date - 1 FROM latest
		UNION ALL SELECT 'year', make_date(EXTRACT(YEAR FROM as_of_date)::integer - 1, 12, 31) FROM latest
	), point_metrics AS (
		SELECT point_dates.label,
			SUM(d.amount * d.annual_rate) FILTER (WHERE d.annual_rate IS NOT NULL)
				/ NULLIF(SUM(d.amount) FILTER (WHERE d.annual_rate IS NOT NULL), 0) AS weighted_rate,
			SUM(d.amount * GREATEST(d.maturity_date - point_dates.as_of_date, 0)) FILTER (WHERE d.maturity_date IS NOT NULL)
				/ NULLIF(SUM(d.amount) FILTER (WHERE d.maturity_date IS NOT NULL), 0) AS weighted_days
		FROM point_dates
		LEFT JOIN debt d ON (d.issue_date IS NULL OR d.issue_date <= point_dates.as_of_date)
			AND (d.maturity_date IS NULL OR d.maturity_date > point_dates.as_of_date)
			AND (d.closed_at IS NULL OR d.closed_at > point_dates.as_of_date)
		GROUP BY point_dates.label
	), snapshot_dates AS (
		SELECT point_dates.label, MAX(snapshot.as_of_date) AS as_of_date
		FROM point_dates
		LEFT JOIN balance_snapshot snapshot ON snapshot.as_of_date <= point_dates.as_of_date
		GROUP BY point_dates.label
	), snapshot_totals AS (
		SELECT snapshot_dates.label, snapshot_dates.as_of_date,
			COALESCE(SUM(snapshot.amount), 0) / 100000000.0 AS balance_yi,
			COALESCE(SUM(snapshot.amount) FILTER (WHERE snapshot.debt_type <> '互换便利'), 0) / 100000000.0 AS regulated_balance_yi
		FROM snapshot_dates
		LEFT JOIN balance_snapshot snapshot ON snapshot.as_of_date = snapshot_dates.as_of_date
		GROUP BY snapshot_dates.label, snapshot_dates.as_of_date
	), current_debt AS (
		SELECT d.* FROM debt d CROSS JOIN latest
		WHERE (d.issue_date IS NULL OR d.issue_date <= latest.as_of_date)
			AND (d.maturity_date IS NULL OR d.maturity_date > latest.as_of_date)
			AND (d.closed_at IS NULL OR d.closed_at > latest.as_of_date)
	), live_metrics AS (
		SELECT COALESCE(SUM(amount), 0) / 100000000.0 AS live_balance_yi,
			SUM(amount * annual_rate) FILTER (WHERE annual_rate IS NOT NULL)
				/ NULLIF(SUM(amount) FILTER (WHERE annual_rate IS NOT NULL), 0) AS weighted_rate,
			SUM(amount * GREATEST(maturity_date - latest.as_of_date, 0)) FILTER (WHERE maturity_date IS NOT NULL)
				/ NULLIF(SUM(amount) FILTER (WHERE maturity_date IS NOT NULL), 0) AS weighted_days,
			COALESCE(SUM(amount) FILTER (WHERE term_days > 365), 0) / 100000000.0 AS long_balance_yi,
			COALESCE(SUM(amount) FILTER (WHERE term_days <= 365), 0) / 100000000.0 AS short_balance_yi,
			COALESCE(SUM(amount) FILTER (
				WHERE COALESCE(NULLIF(d.subtype, ''), d.debt_type) IN ('短期融资券', '同业拆借')
					OR (d.debt_type = '债券' AND d.term_days <= 365)
			), 0) / 100000000.0 AS short_company_debt_yi,
			COALESCE(SUM(amount) FILTER (WHERE
				COALESCE(NULLIF(d.subtype, ''), d.debt_type) IN ('短期融资券', '同业拆借')
				OR (COALESCE(NULLIF(d.subtype, ''), d.debt_type) IN ('浮动收益凭证', '固定收益凭证') AND d.term_days <= 365)
			), 0) / 100000000.0 AS short_debt_yi,
			COALESCE(SUM(amount) FILTER (WHERE annual_rate IS NOT NULL), 0) / NULLIF(SUM(amount), 0) AS rate_coverage,
			COALESCE(SUM(amount) FILTER (WHERE issue_date IS NOT NULL AND maturity_date IS NOT NULL), 0) / NULLIF(SUM(amount), 0) AS lifecycle_coverage
		FROM current_debt d CROSS JOIN latest
	), scheduled_maturity_metrics AS (
		SELECT COALESCE(SUM(d.amount) FILTER (WHERE d.maturity_date <= latest.as_of_date + 30), 0) / 100000000.0 AS due_30_yi,
			COALESCE(SUM(d.amount) FILTER (WHERE d.maturity_date <= make_date(EXTRACT(YEAR FROM latest.as_of_date)::integer, 12, 31)), 0) / 100000000.0 AS due_year_yi
		FROM debt d CROSS JOIN latest
		WHERE d.maturity_date > latest.as_of_date AND d.amount > 0
			AND (d.settled_at IS NULL OR d.settled_at > latest.as_of_date)
			AND (d.closed_at IS NULL OR d.closed_at > latest.as_of_date)
	), largest_borrowing AS (
		SELECT COALESCE(MAX(d.amount), 0) / 100000000.0 AS amount_yi
		FROM debt d CROSS JOIN latest
		WHERE d.issue_date >= date_trunc('year', latest.as_of_date)::date
			AND d.issue_date <= latest.as_of_date
	), parameters AS (
		SELECT COALESCE(jsonb_object_agg(code, jsonb_build_object(
			'label', label, 'valueYi', value_yi, 'periodEnd', period_end, 'notes', notes
		)), '{}'::jsonb) AS value
		FROM finance_parameters
	), composition AS (
		SELECT CASE WHEN NULLIF(snapshot.subtype, '') IS NOT NULL THEN snapshot.subtype ELSE snapshot.debt_type END AS type,
			SUM(snapshot.amount) / 100000000.0 AS amount_yi
		FROM balance_snapshot snapshot
		WHERE snapshot.as_of_date = (SELECT as_of_date FROM snapshot_dates WHERE label = 'current')
		GROUP BY 1
	), months AS (
		SELECT (date_trunc('month', latest.as_of_date) + (value || ' months')::interval)::date AS month_start
		FROM latest CROSS JOIN generate_series(0, 11) AS series(value)
	), maturity AS (
		SELECT date_trunc('month', maturity_date)::date AS month_start,
			SUM(amount) / 100000000.0 AS amount_yi
		FROM current_debt WHERE maturity_date IS NOT NULL GROUP BY 1
	), maturity_by_type AS (
		SELECT date_trunc('month', d.maturity_date)::date AS month_start,
			COALESCE(NULLIF(d.subtype, ''), d.debt_type) AS type, SUM(d.amount) / 100000000.0 AS amount_yi
		FROM current_debt d CROSS JOIN latest
		WHERE d.maturity_date >= date_trunc('month', latest.as_of_date)
			AND d.maturity_date < date_trunc('month', latest.as_of_date) + INTERVAL '12 months'
		GROUP BY 1, 2
	), annual_maturity AS (
		SELECT CASE
				WHEN EXTRACT(YEAR FROM d.maturity_date)::integer = EXTRACT(YEAR FROM latest.as_of_date)::integer THEN EXTRACT(YEAR FROM latest.as_of_date)::integer::text || '年剩余'
				WHEN EXTRACT(YEAR FROM d.maturity_date)::integer <= EXTRACT(YEAR FROM latest.as_of_date)::integer + 4 THEN EXTRACT(YEAR FROM d.maturity_date)::integer::text || '年'
				ELSE (EXTRACT(YEAR FROM latest.as_of_date)::integer + 5)::text || '年以后'
			END AS bucket,
			CASE WHEN EXTRACT(YEAR FROM d.maturity_date)::integer <= EXTRACT(YEAR FROM latest.as_of_date)::integer + 4
				THEN EXTRACT(YEAR FROM d.maturity_date)::integer - EXTRACT(YEAR FROM latest.as_of_date)::integer ELSE 5 END AS bucket_order,
			COALESCE(NULLIF(d.subtype, ''), d.debt_type) AS type, SUM(d.amount) / 100000000.0 AS amount_yi
		FROM current_debt d CROSS JOIN latest
		WHERE d.maturity_date > latest.as_of_date
		GROUP BY 1, 2, 3
	), trend_months AS (
		SELECT LEAST((month_start + INTERVAL '1 month - 1 day')::date, latest.as_of_date) AS month_end
		FROM latest CROSS JOIN LATERAL generate_series(DATE '2021-01-01', date_trunc('month', latest.as_of_date), INTERVAL '1 month') AS series(month_start)
	), trend_snapshot_dates AS (
		SELECT trend_months.month_end,
			(SELECT MAX(snapshot.as_of_date) FROM balance_snapshot snapshot WHERE snapshot.as_of_date <= trend_months.month_end) AS snapshot_date
		FROM trend_months
	), trend_snapshot_totals AS (
		SELECT trend_snapshot_dates.month_end, COALESCE(SUM(snapshot.amount), 0) / 100000000.0 AS balance_yi
		FROM trend_snapshot_dates LEFT JOIN balance_snapshot snapshot ON snapshot.as_of_date = trend_snapshot_dates.snapshot_date
		GROUP BY trend_snapshot_dates.month_end
	), balance_rate_trend AS (
		SELECT trend.month_end, trend.balance_yi,
			SUM(d.amount * d.annual_rate) FILTER (WHERE d.annual_rate IS NOT NULL)
				/ NULLIF(SUM(d.amount) FILTER (WHERE d.annual_rate IS NOT NULL), 0) * 100 AS weighted_rate_pct
		FROM trend_snapshot_totals trend
		LEFT JOIN debt d ON COALESCE(d.issue_date, d.activated_at) <= trend.month_end
			AND (d.maturity_date IS NULL OR d.maturity_date > trend.month_end)
			AND (d.closed_at IS NULL OR d.closed_at > trend.month_end)
		GROUP BY trend.month_end, trend.balance_yi
	), issuance_months AS (
		SELECT date_trunc('month', latest.as_of_date)::date - (value || ' months')::interval AS month_start
		FROM latest CROSS JOIN generate_series(11, 0, -1) AS series(value)
	), issuance_types(type) AS (
		VALUES ('短融'), ('3年公募债'), ('5年公募债'), ('3年次级债'), ('5年次级债')
	), classified_issuances AS (
		SELECT date_trunc('month', d.issue_date)::date AS month_start,
			CASE
				WHEN COALESCE(NULLIF(d.subtype, ''), d.debt_type) = '短期融资券' THEN '短融'
				WHEN COALESCE(NULLIF(d.subtype, ''), d.debt_type) IN ('小公募', '公募债', '科创债') AND ROUND(COALESCE(d.term_days, d.maturity_date - d.issue_date)::numeric / 365.25) = 3 THEN '3年公募债'
				WHEN COALESCE(NULLIF(d.subtype, ''), d.debt_type) IN ('小公募', '公募债', '科创债') AND ROUND(COALESCE(d.term_days, d.maturity_date - d.issue_date)::numeric / 365.25) = 5 THEN '5年公募债'
				WHEN COALESCE(NULLIF(d.subtype, ''), d.debt_type) IN ('次级债', '公募次级') AND ROUND(COALESCE(d.term_days, d.maturity_date - d.issue_date)::numeric / 365.25) = 3 THEN '3年次级债'
				WHEN COALESCE(NULLIF(d.subtype, ''), d.debt_type) IN ('次级债', '公募次级') AND ROUND(COALESCE(d.term_days, d.maturity_date - d.issue_date)::numeric / 365.25) = 5 THEN '5年次级债'
			END AS type, d.amount, d.annual_rate
		FROM debt d CROSS JOIN latest
		WHERE d.debt_type = '债券'
			AND d.issue_date >= date_trunc('month', latest.as_of_date) - INTERVAL '11 months'
			AND d.issue_date <= latest.as_of_date
	), issuance_trend AS (
		SELECT issuance_months.month_start::date AS month_start, issuance_types.type,
			COALESCE(SUM(issuance.amount), 0) / 100000000.0 AS amount_yi,
			SUM(issuance.amount * issuance.annual_rate) FILTER (WHERE issuance.annual_rate IS NOT NULL)
				/ NULLIF(SUM(issuance.amount) FILTER (WHERE issuance.annual_rate IS NOT NULL), 0) * 100 AS weighted_rate_pct
		FROM issuance_months CROSS JOIN issuance_types
		LEFT JOIN classified_issuances issuance ON issuance.month_start = issuance_months.month_start AND issuance.type = issuance_types.type
		GROUP BY 1, 2
		), week_bounds AS (
			SELECT date_trunc('week', latest.as_of_date)::date AS week_start, latest.as_of_date FROM latest
		), event_rows AS (
			SELECT 'maturity'::text AS kind, d.maturity_date AS date,
				CASE WHEN d.maturity_date <= week.as_of_date THEN 'current' ELSE 'next' END AS week,
			d.id::text AS id, d.name, COALESCE(NULLIF(d.subtype, ''), d.debt_type) AS debt_type,
			d.amount / 100000000.0 AS amount_yi, ('/debts/' || d.id::text) AS href
		FROM debt d CROSS JOIN week_bounds week
			WHERE (d.maturity_date BETWEEN week.week_start AND week.as_of_date
					OR d.maturity_date BETWEEN week.week_start + 7 AND week.week_start + 11)
			AND EXTRACT(ISODOW FROM d.maturity_date) <= 5 AND d.amount > 0
			AND COALESCE(NULLIF(d.subtype, ''), d.debt_type) NOT IN ('同业拆借', '浮动收益凭证')
		UNION ALL
		SELECT 'interest', c.due_date,
				CASE WHEN c.due_date <= week.as_of_date THEN 'current' ELSE 'next' END,
			(c.debt_id::text || ':' || c.sequence::text), d.name, COALESCE(NULLIF(d.subtype, ''), d.debt_type),
			COALESCE(c.amount, 0) / 100000000.0, ('/debts/' || d.id::text)
		FROM cashflow c JOIN current_debt d ON d.id = c.debt_id CROSS JOIN week_bounds week
			WHERE c.cashflow_type = 'interest'
				AND (c.due_date BETWEEN week.week_start AND week.as_of_date
					OR c.due_date BETWEEN week.week_start + 7 AND week.week_start + 11)
			AND EXTRACT(ISODOW FROM c.due_date) <= 5 AND (d.maturity_date IS NULL OR d.maturity_date <> c.due_date)
			AND COALESCE(NULLIF(d.subtype, ''), d.debt_type) NOT IN ('同业拆借', '浮动收益凭证')
		UNION ALL
		SELECT 'issue', CASE WHEN d.debt_type = '收益凭证' THEN COALESCE(certificate.subscription_date, d.issue_date) ELSE d.issue_date END,
				CASE WHEN (CASE WHEN d.debt_type = '收益凭证' THEN COALESCE(certificate.subscription_date, d.issue_date) ELSE d.issue_date END) <= week.as_of_date THEN 'current' ELSE 'next' END,
			d.id::text, d.name, COALESCE(NULLIF(d.subtype, ''), d.debt_type), d.amount / 100000000.0, ('/debts/' || d.id::text)
		FROM debt d LEFT JOIN ONLY financing.income_certificate certificate ON certificate.id = d.id CROSS JOIN week_bounds week CROSS JOIN latest
			WHERE ((CASE WHEN d.debt_type = '收益凭证' THEN COALESCE(certificate.subscription_date, d.issue_date) ELSE d.issue_date END) BETWEEN week.week_start AND week.as_of_date
					OR (CASE WHEN d.debt_type = '收益凭证' THEN COALESCE(certificate.subscription_date, d.issue_date) ELSE d.issue_date END) BETWEEN week.week_start + 7 AND week.week_start + 11)
			AND EXTRACT(ISODOW FROM (CASE WHEN d.debt_type = '收益凭证' THEN COALESCE(certificate.subscription_date, d.issue_date) ELSE d.issue_date END)) <= 5
			AND (d.closed_at IS NULL OR d.closed_at > latest.as_of_date)
			AND COALESCE(NULLIF(d.subtype, ''), d.debt_type) NOT IN ('同业拆借', '浮动收益凭证')
	), due_detail AS (
		SELECT d.id::text AS id, COALESCE(NULLIF(d.subtype, ''), d.debt_type) AS debt_type, d.counterparty,
			d.amount / 100000000.0 AS principal_yi, d.interest_payable / 100000000.0 AS interest_yi,
			d.annual_rate, d.maturity_date AS due_date
		FROM debt d CROSS JOIN latest
		WHERE d.maturity_date > latest.as_of_date AND d.maturity_date <= latest.as_of_date + 30
			AND d.amount > 0 AND (d.settled_at IS NULL OR d.settled_at > latest.as_of_date)
			AND (d.closed_at IS NULL OR d.closed_at > latest.as_of_date)
			AND COALESCE(NULLIF(d.subtype, ''), d.debt_type) NOT IN ('同业拆借', '浮动收益凭证')
		ORDER BY due_date, principal_yi DESC, interest_yi DESC, d.name
		LIMIT 30
	), active_projects AS (
		SELECT project.id, project.name, project.debt_type, project.amount / 100000000.0 AS amount_yi,
			project.planned_issue_date, project.planned_maturity_date, project.status,
			owner.name AS owner_name, project.notes, project.expected_rate_min, project.expected_rate_max,
			project.funding_cost_rate, project.tenor_description, project.amount_description
		FROM projects project LEFT JOIN people owner ON owner.id = project.owner_id
		WHERE project.status IN ('planning', 'in_progress', 'at_risk')
		ORDER BY project.planned_issue_date, project.name
	), raw_market_history AS (
		SELECT definition.series_id, definition.series_name, definition.category, definition.tenor,
			observation.observation_date, observation.value::double precision AS value, definition.unit
		FROM public.edb observation JOIN liability_rate_series definition ON definition.series_id = observation.indicator_code CROSS JOIN latest
		WHERE observation.observation_date BETWEEN date_trunc('year', latest.as_of_date)::date AND latest.as_of_date
	), market_spread_history AS (
		SELECT pair.broker_series_id || '-' || pair.government_series_id AS series_id,
			pair.tenor || '信用利差' AS series_name, pair.category, pair.tenor, broker.observation_date,
			(broker.value - government.value)::double precision * 100 AS value, 'bp'::text AS unit
		FROM liability_spread_pairs pair
		JOIN public.edb broker ON broker.indicator_code = pair.broker_series_id
		JOIN public.edb government ON government.indicator_code = pair.government_series_id AND government.observation_date = broker.observation_date
		CROSS JOIN latest
		WHERE broker.observation_date BETWEEN date_trunc('year', latest.as_of_date)::date AND latest.as_of_date
	), market_history AS (
		SELECT * FROM raw_market_history UNION ALL SELECT * FROM market_spread_history
	), market_observations AS (
		SELECT series_id, series_name, category, tenor, observation_date, value, unit
		FROM (
			SELECT history.*, ROW_NUMBER() OVER (PARTITION BY history.category, history.series_id ORDER BY history.observation_date DESC) AS row_number
			FROM market_history history
		) latest_observation WHERE row_number = 1
	), missing_maturity AS (
		SELECT id, name, counterparty, amount
		FROM debt CROSS JOIN latest
		WHERE activated_at IS NOT NULL AND activated_at <= latest.as_of_date
			AND maturity_date IS NULL AND closed_at IS NULL AND status IN ('active', 'matured')
	), net_capital AS (
		SELECT value_yi, period_end FROM finance_parameters WHERE code = 'prior_month_net_capital'
	), limit_usage AS (
		SELECT config.debt_type,
			CASE WHEN config.usage_basis = 'since_approval' THEN (
				SELECT COALESCE(SUM(d.amount), 0) / 100000000.0 FROM debt d CROSS JOIN latest
				WHERE COALESCE(NULLIF(d.subtype, ''), d.debt_type) = CASE WHEN config.debt_type = '公募次级' THEN '次级债' ELSE config.debt_type END
					AND d.issue_date >= COALESCE(config.approved_date, DATE '0001-01-01') AND d.issue_date <= latest.as_of_date
			) ELSE (
				SELECT COALESCE(SUM(snapshot.amount), 0) / 100000000.0 FROM balance_snapshot snapshot
				WHERE snapshot.as_of_date = (SELECT as_of_date FROM snapshot_dates WHERE label = 'current')
					AND (snapshot.debt_type = config.debt_type OR NULLIF(snapshot.subtype, '') = CASE WHEN config.debt_type = '公募次级' THEN '次级债' ELSE config.debt_type END)
			) END AS issued_yi
		FROM debt_limit_configs config
	), limit_rows AS (
		SELECT config.debt_type AS "debtType",
			CASE WHEN config.calculation_mode = 'net_capital_60' AND net.value_yi IS NOT NULL THEN net.value_yi * 0.6 ELSE config.limit_yi END AS "limitYi",
			config.limit_yi AS "configuredLimitYi", usage.issued_yi AS "issuedYi",
			CASE WHEN config.calculation_mode = 'net_capital_60' AND net.value_yi IS NOT NULL THEN net.value_yi * 0.6 ELSE config.limit_yi END - usage.issued_yi AS "remainingYi",
			config.usage_basis AS "usageBasis", config.approved_date AS "approvedDate", config.expiry_date AS "expiryDate",
			config.calculation_mode AS "calculationMode", config.sort_order AS "sortOrder",
			(config.calculation_mode = 'net_capital_60' AND (net.period_end IS NULL OR net.period_end < date_trunc('month', latest.as_of_date)::date - 1)) AS "needsNetCapitalUpdate"
		FROM debt_limit_configs config JOIN limit_usage usage USING (debt_type) LEFT JOIN net_capital net ON TRUE CROSS JOIN latest
		ORDER BY config.sort_order, config.debt_type
	), report_row AS (
		SELECT latest.as_of_date AS "asOfDate", args.today AS "today",
			(SELECT as_of_date FROM snapshot_dates WHERE label = 'current') AS "balanceSnapshotDate",
			(SELECT balance_yi FROM snapshot_totals WHERE label = 'current') AS "balanceYi",
			(SELECT balance_yi FROM snapshot_totals WHERE label = 'month') AS "previousMonthBalanceYi",
			(SELECT balance_yi FROM snapshot_totals WHERE label = 'year') AS "previousYearBalanceYi",
			(SELECT regulated_balance_yi FROM snapshot_totals WHERE label = 'month') - (SELECT regulated_balance_yi FROM snapshot_totals WHERE label = 'year') AS "cumulativeBorrowingYi",
			(SELECT as_of_date FROM snapshot_totals WHERE label = 'month') AS "cumulativeBorrowingDate",
			live_metrics.live_balance_yi AS "liveBalanceYi", live_metrics.weighted_rate AS "weightedRate", live_metrics.weighted_days AS "weightedDays",
			(SELECT weighted_rate FROM point_metrics WHERE label = 'month') AS "previousMonthRate",
			(SELECT weighted_rate FROM point_metrics WHERE label = 'year') AS "previousYearRate",
			(SELECT weighted_days FROM point_metrics WHERE label = 'month') AS "previousMonthDays",
			(SELECT weighted_days FROM point_metrics WHERE label = 'year') AS "previousYearDays",
			live_metrics.long_balance_yi AS "longBalanceYi", live_metrics.short_balance_yi AS "shortBalanceYi",
			scheduled_maturity_metrics.due_30_yi AS "due30Yi", scheduled_maturity_metrics.due_year_yi AS "dueYearYi",
			live_metrics.short_company_debt_yi AS "shortCompanyDebtYi", live_metrics.short_debt_yi AS "shortDebtYi",
			live_metrics.rate_coverage AS "rateCoverage", live_metrics.lifecycle_coverage AS "lifecycleCoverage",
			(SELECT amount_yi FROM largest_borrowing) AS "largestBorrowingYi", (SELECT value FROM parameters) AS parameters,
			(SELECT COUNT(*) FROM missing_maturity) AS "missingMaturityCount",
			(SELECT COALESCE(SUM(amount), 0) / 100000000.0 FROM missing_maturity) AS "missingMaturityAmountYi",
			(SELECT string_agg(item.name || ' · ' || COALESCE(item.counterparty, '对手方缺失') || ' · ' || round(item.amount / 100000000, 4)::text || '亿元', '；' ORDER BY item.amount DESC, item.id) FROM (SELECT * FROM missing_maturity ORDER BY amount DESC, id LIMIT 5) item) AS "missingMaturityDetails",
			COALESCE((SELECT jsonb_agg(jsonb_build_object('type', type, 'amountYi', amount_yi) ORDER BY amount_yi DESC, type) FROM composition), '[]'::jsonb) AS composition,
			COALESCE((SELECT jsonb_agg(jsonb_build_object('month', to_char(months.month_start, 'YYYY-MM'), 'amountYi', COALESCE(maturity.amount_yi, 0)) ORDER BY months.month_start) FROM months LEFT JOIN maturity USING (month_start)), '[]'::jsonb) AS "maturityDistribution",
			COALESCE((SELECT jsonb_agg(jsonb_build_object('month', to_char(month_start, 'YYYY-MM'), 'type', type, 'amountYi', amount_yi) ORDER BY month_start, type) FROM maturity_by_type), '[]'::jsonb) AS "maturityByType",
			COALESCE((SELECT jsonb_agg(jsonb_build_object('bucket', bucket, 'bucketOrder', bucket_order, 'type', type, 'amountYi', amount_yi) ORDER BY bucket_order, type) FROM annual_maturity), '[]'::jsonb) AS "annualMaturity",
			COALESCE((SELECT jsonb_agg(jsonb_build_object('date', month_end, 'balanceYi', balance_yi, 'weightedRatePct', weighted_rate_pct) ORDER BY month_end) FROM balance_rate_trend), '[]'::jsonb) AS "balanceRateTrend",
			COALESCE((SELECT jsonb_agg(jsonb_build_object('month', to_char(month_start, 'YYYY-MM'), 'type', type, 'amountYi', amount_yi, 'weightedRatePct', weighted_rate_pct) ORDER BY month_start, type) FROM issuance_trend), '[]'::jsonb) AS "issuanceTrend",
			COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', kind, 'date', date, 'week', week, 'id', id, 'name', name, 'debtType', debt_type, 'amountYi', amount_yi, 'href', href) ORDER BY date, kind, name) FROM event_rows), '[]'::jsonb) AS events,
			COALESCE((SELECT jsonb_agg(to_jsonb(due_detail) ORDER BY due_date, principal_yi DESC) FROM due_detail), '[]'::jsonb) AS "dueDetails",
			COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name, 'debtType', debt_type, 'amountYi', amount_yi, 'plannedIssueDate', planned_issue_date, 'plannedMaturityDate', planned_maturity_date, 'status', status, 'ownerName', owner_name, 'notes', notes, 'expectedRateMin', expected_rate_min, 'expectedRateMax', expected_rate_max, 'fundingCostRate', funding_cost_rate, 'tenorDescription', tenor_description, 'amountDescription', amount_description) ORDER BY planned_issue_date, name) FROM active_projects), '[]'::jsonb) AS projects,
			COALESCE((SELECT jsonb_agg(jsonb_build_object('seriesId', series_id, 'seriesName', series_name, 'category', category, 'tenor', tenor, 'observationDate', observation_date, 'value', value, 'unit', unit) ORDER BY category, tenor, series_name) FROM market_observations), '[]'::jsonb) AS "marketObservations",
			COALESCE((SELECT jsonb_agg(jsonb_build_object('seriesId', series_id, 'seriesName', series_name, 'category', category, 'tenor', tenor, 'observationDate', observation_date, 'value', value, 'unit', unit) ORDER BY category, series_id, observation_date) FROM market_history), '[]'::jsonb) AS "marketHistory"
		FROM latest CROSS JOIN args CROSS JOIN live_metrics CROSS JOIN scheduled_maturity_metrics
	)
	SELECT jsonb_build_object(
		'version', 1,
		'report', to_jsonb(report_row),
		'limits', COALESCE((SELECT jsonb_agg(to_jsonb(limit_rows)) FROM limit_rows), '[]'::jsonb)
	) INTO result
	FROM report_row;

	RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION liability_weekly_report_data(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION liability_weekly_report_data(date) TO authenticated;

COMMENT ON FUNCTION liability_weekly_report_data(date) IS
	'Authenticated Neon Data API RPC that aggregates financing-owned liability weekly report data for one report date.';

COMMIT;

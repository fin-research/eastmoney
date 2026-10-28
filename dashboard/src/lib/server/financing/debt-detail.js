// @ts-nocheck
const number = (value) => Number(value ?? 0);
const DETAIL_FIELDS = {
	'债券': [
		['issuanceMethod', '发行方式'], ['bookbuildingDate', '簿记日'], ['interestBasis', '计息基准'],
		['issuanceTarget', '发行对象'], ['market', '市场'], ['receivingAccount', '收款账户'],
		['trustee', '受托管理人'], ['bookrunner', '簿记管理人']
	],
	'收益凭证': [
		['liquidationSubmissionStatus', '清盘提交'], ['liquidationRegistrationStatus', '清盘注册'],
		['returnType', '收益类型'], ['receivingAccount', '收款账户'], ['earlyMaturity', '是否提前到期']
	],
	'收益权转让': [['interestBasisDays', '年化计息天数']],
	'转融资': [
		['interestBasisDays', '年化计息天数'], ['market', '市场'], ['isExtended', '是否展期'],
		['receivingAccount', '收款账户'], ['repaymentAccount', '还款账户']
	],
	'互换便利': [
		['averageRepoBalanceDescription', '正回购日均余额'], ['repoWeightedAverageRate', '正回购加权平均利率']
	]
};

function fieldDisplayValue(value) {
	if (value == null || value === '') return null;
	if (typeof value === 'boolean') return value ? '是' : '否';
	return typeof value === 'number'
		? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 10, useGrouping: false }).format(value)
		: String(value);
}

export async function loadDebtDetail(db, id) {
	if (!/^\d+$/.test(String(id))) return null;
	const debt = await db.prepare(`
		SELECT d.id, d.debt_type AS debtType, d.subtype, d.name, d.counterparty,
			d.amount, d.interest_payable AS interestPayable, d.total_amount AS totalAmount,
			d.annual_rate AS annualRate, d.issue_date AS issueDate, d.maturity_date AS maturityDate,
			d.term_days AS termDays, d.activated_at AS activatedAt,
			d.settled_at AS settledAt, d.closed_at AS closedAt, financing.debt_status_as_of(d.issue_date,d.maturity_date,d.activated_at,d.settled_at,d.closed_at,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date) AS status,
			b.issuance_method AS issuanceMethod, b.bookbuilding_date AS bookbuildingDate,
			b.interest_basis AS interestBasis, b.issuance_target AS issuanceTarget,
			b.market AS bondMarket, b.receiving_account AS bondReceivingAccount, b.trustee, b.bookrunner,
			certificate.liquidation_submission_status AS liquidationSubmissionStatus,
			certificate.liquidation_registration_status AS liquidationRegistrationStatus,
			certificate.return_type AS returnType, certificate.receiving_account AS certificateReceivingAccount,
			certificate.early_maturity AS earlyMaturity,
			right_detail.interest_basis_days AS incomeRightInterestBasisDays,
			refinancing.interest_basis_days AS refinancingInterestBasisDays,
			refinancing.market AS refinancingMarket, refinancing.is_extended AS isExtended,
			refinancing.receiving_account AS refinancingReceivingAccount,
			refinancing.repayment_account AS repaymentAccount,
			swap.average_repo_balance_description AS averageRepoBalanceDescription,
			swap.repo_weighted_average_rate AS repoWeightedAverageRate
		FROM financing.debt d
		LEFT JOIN ONLY financing.bond b ON b.id = d.id
		LEFT JOIN ONLY financing.income_certificate certificate ON certificate.id = d.id
		LEFT JOIN ONLY financing.income_right right_detail ON right_detail.id = d.id
		LEFT JOIN ONLY financing.refinancing refinancing ON refinancing.id = d.id
		LEFT JOIN ONLY financing.swap_facility swap ON swap.id = d.id
		WHERE d.id = ?::bigint
	`).get(id);
	if (!debt) return null;
	debt.market = debt.bondMarket ?? debt.refinancingMarket;
	debt.receivingAccount = debt.bondReceivingAccount ?? debt.certificateReceivingAccount ?? debt.refinancingReceivingAccount;
	debt.interestBasisDays = debt.incomeRightInterestBasisDays ?? debt.refinancingInterestBasisDays;
	const cashflows = (await db.prepare(`
		SELECT sequence, cashflow_type AS eventType, due_date AS eventDate, amount,
			paid_amount AS paidAmount, paid_at AS paidAt, accrual_start_date AS accrualStartDate,
			accrual_end_date AS accrualEndDate, note
		FROM cashflow WHERE debt_id = ?::bigint ORDER BY due_date, sequence
	`).all(id)).map((item) => ({
		...item, id: `${id}:${item.sequence}`, amount: item.amount == null ? null : number(item.amount),
		paidAmount: item.paidAmount == null ? null : number(item.paidAmount)
	}));
	const fields = (DETAIL_FIELDS[debt.debtType] ?? []).map(([property, fieldName]) => ({
		rowSequence: 0, fieldName, displayValue: fieldDisplayValue(debt[property])
	}));
	return {
		...debt,
		amount: number(debt.amount), interestPayable: number(debt.interestPayable), totalAmount: number(debt.totalAmount),
		annualRate: debt.annualRate == null ? null : number(debt.annualRate),
		fields,
		cashflows
	};
}


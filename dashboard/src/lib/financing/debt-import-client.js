// @ts-nocheck

/** Create a client identity from a source account label without inventing a legal full name. */
export function clientFromDebtCounterparty(counterparty) {
	const raw = String(counterparty ?? '').trim();
	if (!raw) return null;
	const branch = /^营业部(?:大客户|散户)(?:[-－—])?(?=.)/u.test(raw);
	const sourceName = raw.replace(/^(?:银行|机构投资者)[-－—]|^营业部(?:大客户|散户)(?:[-－—])?(?=.)/u, '').trim();
	const product = sourceName.match(/公司(?:[（(]?(?:代表|代)[）)]?)?[“"]?(.+?(?:资产管理计划|资金信托计划|私募证券投资基金))[”"）)]*$/u);
	const name = (product?.[1]?.replace(/^(?:代|代表)[“"]?/u, '') ?? sourceName).trim();
	if (!name || name.length > 500) return null;
	const type = branch ? '营业部客户'
		: /(?:银行|农商行|农信联社)(?:股份有限公司|有限责任公司)?$/u.test(name) ? '银行'
			: /理财(?:有限责任公司|有限公司)?$/u.test(name) ? '理财子'
				: /证券(?:股份有限公司|有限责任公司|有限公司)?$/u.test(name) ? '券商'
					: /基金管理(?:股份有限公司|有限责任公司|有限公司)?$/u.test(name) ? '基金' : '其它';
	return { name, fullname: null, type, subtype: null };
}

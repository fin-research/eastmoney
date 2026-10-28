export const DEBT_FIELD_COLUMN_COUNT = 64;
export const DEBT_FIELD_COLUMNS = Array.from(
	{ length: DEBT_FIELD_COLUMN_COUNT },
	(_, index) => `value_${index}`
);

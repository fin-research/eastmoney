BEGIN;

-- The user confirmed these four workbook paragraphs are notes, not liabilities.
-- Keep any row with real amounts, dates or cashflows for manual investigation.
DELETE FROM ONLY financing.debt d
WHERE d.debt_type = '集团借款'
  AND d.amount = 0 AND d.interest_payable = 0
  AND d.issue_date IS NULL AND d.maturity_date IS NULL AND d.activated_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM financing.cashflow c WHERE c.debt_id = d.id)
  AND (
    d.counterparty = '截至目前集团共发行3次可转债：'
    OR d.counterparty LIKE '1、东财转1（123006）：发行时间2017年12月，%'
    OR d.counterparty LIKE '2、东财转2（123041）：发行时间2020年1月，%'
    OR d.counterparty LIKE '3、东财转3（123111）：发行时间2021年4月，%'
  );

COMMIT;

ALTER VIEW credit.ai_ledger RENAME TO masked;
ALTER FUNCTION credit.ai_ledger_as_of(date) RENAME TO masked_as_of;

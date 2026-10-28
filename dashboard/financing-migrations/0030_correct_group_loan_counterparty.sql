-- User-confirmed investor correction for the historical 2021 group loan.
SELECT pg_advisory_xact_lock(hashtext('financing.local_debt_maintenance'));
UPDATE financing.debt SET counterparty='集团公司',
  name='集团借款·集团公司·2021-09-06',
  client_id=(SELECT id FROM public.client WHERE name='集团公司')
WHERE id=9445 AND debt_type='集团借款' AND amount=500000000
  AND issue_date='2021-09-06' AND maturity_date='2021-09-14'
  AND counterparty='东方财富证券股份有限公司';

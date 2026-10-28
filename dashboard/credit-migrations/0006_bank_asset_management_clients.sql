-- Apply financing/0031_bank_client_identity.sql first.
SELECT pg_advisory_xact_lock(hashtext('financing.local_debt_maintenance'));
SELECT pg_advisory_xact_lock(hashtextextended('credit.excel_import',0));

-- Only explicitly named bank asset departments are split. Generic product-manager
-- strings do not match bank_client_context and keep their verified investor aliases.
CREATE TEMP TABLE bank_asset_names ON COMMIT DROP AS
WITH source_names AS (
  SELECT institution_name AS name FROM credit.institution
  UNION SELECT institution_name FROM credit.institution_client
  UNION SELECT counterparty FROM financing.debt WHERE counterparty IS NOT NULL
  UNION SELECT alias FROM public.client_alias WHERE match_kind='exact'
), contexts AS (
  SELECT n.name,b.bank_id FROM source_names n CROSS JOIN LATERAL public.bank_client_context(n.name) b
    WHERE b.is_asset_management
)
SELECT name,min(bank_id) AS bank_id FROM contexts GROUP BY name HAVING count(DISTINCT bank_id)=1;

INSERT INTO public.client(name,fullname,type,subtype)
  SELECT DISTINCT c.name||'资管',NULL,'理财子','银行资管'
  FROM bank_asset_names n JOIN public.client c ON c.id=n.bank_id
  ON CONFLICT(name) DO UPDATE SET type='理财子',subtype='银行资管';

CREATE TEMP TABLE bank_asset_clients ON COMMIT DROP AS
SELECT DISTINCT bank.id AS bank_id,asset.id AS asset_id FROM bank_asset_names n
JOIN public.client bank ON bank.id=n.bank_id
JOIN public.client asset ON asset.name=bank.name||'资管' AND asset.type='理财子';

-- Correct old department aliases, keeping all already verified actual investors.
UPDATE public.client_alias a SET client_id=s.asset_id,notes='银行资管独立客户，按业务口径归类理财子'
FROM bank_asset_names n JOIN bank_asset_clients s USING(bank_id)
WHERE a.match_kind='exact' AND a.alias=public.normalize_client_name(n.name)
  AND a.client_id IN(s.bank_id,s.asset_id);
INSERT INTO public.client_alias(alias,match_kind,client_id,notes)
  SELECT DISTINCT public.normalize_client_name(n.name),'exact',s.asset_id,'银行资管独立客户，按业务口径归类理财子'
  FROM bank_asset_names n JOIN bank_asset_clients s USING(bank_id)
  ON CONFLICT(alias,match_kind) DO UPDATE SET client_id=EXCLUDED.client_id,notes=EXCLUDED.notes;

UPDATE credit.institution_client m SET client_id=s.asset_id,notes='明确资管归独立理财子客户'
FROM bank_asset_names n JOIN bank_asset_clients s USING(bank_id)
WHERE m.institution_name=n.name AND m.client_id=s.bank_id;
UPDATE credit.institution_client m SET notes='未标明资管，归银行自营客户'
FROM bank_asset_clients s WHERE m.client_id=s.bank_id;

-- Reconcile only identities within the same bank family; other manual selections
-- are not implicated by this migration. Keep the source counterparty text intact.
WITH names AS MATERIALIZED (
  SELECT DISTINCT d.counterparty,b.bank_id,public.resolve_client(d.counterparty) AS resolved_id
  FROM financing.debt d CROSS JOIN LATERAL public.bank_client_context(d.counterparty) b
  JOIN bank_asset_clients s ON s.bank_id=b.bank_id
)
UPDATE financing.debt d SET client_id=n.resolved_id
FROM names n JOIN bank_asset_clients s USING(bank_id)
WHERE d.counterparty=n.counterparty AND n.resolved_id IS NOT NULL
  AND (d.client_id IS NULL OR d.client_id IN(s.bank_id,s.asset_id))
  AND d.client_id IS DISTINCT FROM n.resolved_id;

-- One customer belongs to one credit subject for every financing item type.
-- Reject residual duplicate ownership before removing the old scopes.
CREATE UNIQUE INDEX institution_client_owner ON credit.institution_client(client_id);

CREATE OR REPLACE VIEW credit.item_usage AS
WITH dates AS (SELECT DISTINCT report_date FROM credit.institution),
financing_usage AS (
  SELECT dates.report_date, u.* FROM dates CROSS JOIN LATERAL financing.credit_usage_as_of(dates.report_date) u
), mapped AS (
  SELECT dates.report_date, m.institution_name, t.item_type,
    count(DISTINCT m.client_id) AS linked_client_count,
    coalesce(sum(u.amount),0) / 100000000 AS financing_used
  FROM credit.institution_client m CROSS JOIN dates
  CROSS JOIN (VALUES ('yield_certificate'::credit.item_type), ('interbank_lending'::credit.item_type)) t(item_type)
  LEFT JOIN financing_usage u ON u.report_date = dates.report_date AND u.client_id = m.client_id
    AND u.debt_type = CASE t.item_type WHEN 'yield_certificate' THEN '收益凭证' ELSE '同业拆借' END
  GROUP BY dates.report_date, m.institution_name, t.item_type
)
SELECT i.*, i.used_amount AS imported_used_amount,
  CASE WHEN i.item_type IN ('yield_certificate','interbank_lending') THEN
    CASE WHEN m.linked_client_count > 0 THEN m.financing_used ELSE NULL END
    ELSE i.used_amount END AS effective_used_amount,
  CASE WHEN i.item_type IN ('yield_certificate','interbank_lending') THEN 'financing' ELSE 'credit' END AS usage_source,
  CASE WHEN i.item_type IN ('yield_certificate','interbank_lending') THEN coalesce(m.linked_client_count,0) ELSE NULL END AS linked_client_count
FROM credit.item i LEFT JOIN mapped m USING (report_date, institution_name, item_type);

ALTER TABLE credit.institution_client DROP COLUMN yield_certificate, DROP COLUMN interbank_lending;
COMMENT ON TABLE credit.institution_client IS '静态授信主体与客户关联；银行自营和资管分别建客户，不区分融资品种';

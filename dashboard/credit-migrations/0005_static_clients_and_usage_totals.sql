-- Shared static customer ownership and one item-sum caliber for every report.
SELECT pg_advisory_xact_lock(hashtextextended('credit.excel_import', 0));

DROP VIEW credit.institution_usage;
DROP VIEW credit.usage_reconciliation;
DROP VIEW credit.item_usage;
DROP TRIGGER link_institution_clients ON credit.institution;
DROP FUNCTION credit.link_institution_clients();
DROP TRIGGER sync_manual_usage_delta ON credit.item;
DROP FUNCTION credit.sync_manual_usage_delta();

-- Refuse to silently choose between conflicting historical ownership rules.
CREATE TEMP TABLE merged_credit_clients ON COMMIT DROP AS
SELECT institution_name,client_id,yield_certificate,interbank_lending FROM credit.client_mapping
UNION
SELECT institution_name,client_id,yield_certificate,interbank_lending FROM credit.institution_client;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM merged_credit_clients GROUP BY institution_name,client_id HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Historical credit client ownership differs; reconcile before making ownership static';
  END IF;
END $$;
DROP TABLE credit.institution_client;
ALTER TABLE credit.client_mapping RENAME TO institution_client;
ALTER TABLE credit.institution_client RENAME CONSTRAINT client_mapping_pkey TO institution_client_pkey;
ALTER INDEX credit.client_mapping_yield_owner RENAME TO institution_client_yield_owner;
ALTER INDEX credit.client_mapping_lending_owner RENAME TO institution_client_lending_owner;
INSERT INTO credit.institution_client(institution_name,client_id,yield_certificate,interbank_lending,notes)
  SELECT institution_name,client_id,yield_certificate,interbank_lending,'从既有报表关联迁移'
  FROM merged_credit_clients ON CONFLICT(institution_name,client_id) DO NOTHING;
COMMENT ON TABLE credit.institution_client IS '不随报表日期变化的授信主体与客户归属；报表重导不删除';
COMMENT ON COLUMN credit.institution_client.yield_certificate IS '该客户收益凭证是否计入此授信主体；同一客户只能有一个收益凭证主体';
COMMENT ON COLUMN credit.institution_client.interbank_lending IS '该客户同业拆借是否计入此授信主体；同一客户只能有一个拆借主体';

CREATE FUNCTION credit.link_institution_clients() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, credit AS $$
DECLARE candidate_ids bigint[]; candidate_count integer;
BEGIN
  IF EXISTS (SELECT 1 FROM credit.institution_client WHERE institution_name=NEW.institution_name) THEN RETURN NEW; END IF;
  SELECT array_agg(DISTINCT public.resolve_client(part)),count(*) INTO candidate_ids,candidate_count
  FROM regexp_split_to_table(NEW.institution_name, '[&＆]') part;
  IF array_position(candidate_ids,NULL) IS NULL AND cardinality(candidate_ids)=candidate_count
    AND NOT EXISTS (SELECT 1 FROM credit.institution_client WHERE client_id=ANY(candidate_ids)) THEN
    INSERT INTO credit.institution_client(institution_name,client_id,notes)
      SELECT NEW.institution_name,unnest(candidate_ids),'完整名称自动匹配';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER link_institution_clients AFTER INSERT ON credit.institution
FOR EACH ROW EXECUTE FUNCTION credit.link_institution_clients();

ALTER TABLE credit.institution DROP COLUMN source_row, DROP COLUMN included_in_weekly_report;
ALTER TABLE credit.institution ALTER COLUMN confidentiality_status TYPE boolean
  USING (confidentiality_status::text='signed'), ALTER COLUMN confidentiality_status SET DEFAULT false;
DROP TYPE credit.confidentiality_status;
COMMENT ON COLUMN credit.institution.confidentiality_status IS '是否已签署保密协议；未签署及未知均为 false';
ALTER TABLE credit.institution_event DROP COLUMN source_row;
CREATE INDEX credit_institution_event_recent_idx ON credit.institution_event(report_date DESC,event_type,institution_name);

-- User-confirmed historical corrections. The item table retains imported financing
-- amounts for reconciliation, while the displayed amounts still come from financing.
UPDATE credit.item SET used_amount=45,updated_at=clock_timestamp()
WHERE report_date='2026-08-28' AND institution_name='浦发银行' AND item_type='yield_certificate';
UPDATE credit.item SET used_amount=0.0245,updated_at=clock_timestamp()
WHERE report_date='2026-08-21' AND institution_name='北京农商行' AND item_type='other';
UPDATE credit.item SET used_amount=0.5,updated_at=clock_timestamp()
WHERE report_date='2026-08-21' AND institution_name='昆山农商行' AND item_type='bond_investment';

-- total_used is a stored sum of raw items, never an independent editable amount.
-- The effective view below independently sums financing-replaced item usage.
CREATE FUNCTION credit.set_institution_usage_sum() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, credit AS $$
BEGIN
  SELECT coalesce(sum(used_amount),0) INTO NEW.total_used FROM credit.item
    WHERE report_date=NEW.report_date AND institution_name=NEW.institution_name;
  RETURN NEW;
END $$;
CREATE TRIGGER set_institution_usage_sum BEFORE INSERT OR UPDATE OF total_used ON credit.institution
FOR EACH ROW EXECUTE FUNCTION credit.set_institution_usage_sum();
UPDATE credit.institution SET total_used=0;

CREATE FUNCTION credit.sync_item_usage_sum() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, credit AS $$
DECLARE affected jsonb;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT jsonb_agg(k) INTO affected FROM (SELECT DISTINCT report_date,institution_name FROM new_items) k;
  ELSIF TG_OP='DELETE' THEN
    SELECT jsonb_agg(k) INTO affected FROM (SELECT DISTINCT report_date,institution_name FROM old_items) k;
  ELSE
    SELECT jsonb_agg(k) INTO affected FROM (
      SELECT report_date,institution_name FROM new_items UNION SELECT report_date,institution_name FROM old_items
    ) k;
  END IF;
  -- Serialize updates per institution before recomputing, including concurrent
  -- changes to different items. The statement trigger also handles bulk imports.
  PERFORM 1 FROM credit.institution i JOIN jsonb_to_recordset(affected) AS k(report_date date,institution_name text)
    USING(report_date,institution_name) ORDER BY i.report_date,i.institution_name FOR UPDATE OF i;
  UPDATE credit.institution i SET total_used=0,updated_at=clock_timestamp()
    FROM jsonb_to_recordset(affected) AS k(report_date date,institution_name text)
    WHERE i.report_date=k.report_date AND i.institution_name=k.institution_name;
  RETURN NULL;
END $$;
CREATE TRIGGER sync_item_usage_insert AFTER INSERT ON credit.item REFERENCING NEW TABLE AS new_items
FOR EACH STATEMENT EXECUTE FUNCTION credit.sync_item_usage_sum();
CREATE TRIGGER sync_item_usage_update AFTER UPDATE ON credit.item REFERENCING OLD TABLE AS old_items NEW TABLE AS new_items
FOR EACH STATEMENT EXECUTE FUNCTION credit.sync_item_usage_sum();
CREATE TRIGGER sync_item_usage_delete AFTER DELETE ON credit.item REFERENCING OLD TABLE AS old_items
FOR EACH STATEMENT EXECUTE FUNCTION credit.sync_item_usage_sum();

CREATE VIEW credit.item_usage AS
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
    AND CASE t.item_type WHEN 'yield_certificate' THEN m.yield_certificate ELSE m.interbank_lending END
  GROUP BY dates.report_date, m.institution_name, t.item_type
)
SELECT i.*, i.used_amount AS imported_used_amount,
  CASE WHEN i.item_type IN ('yield_certificate','interbank_lending') THEN
    CASE WHEN m.linked_client_count > 0 THEN m.financing_used ELSE NULL END
    ELSE i.used_amount END AS effective_used_amount,
  CASE WHEN i.item_type IN ('yield_certificate','interbank_lending') THEN 'financing' ELSE 'credit' END AS usage_source,
  CASE WHEN i.item_type IN ('yield_certificate','interbank_lending') THEN coalesce(m.linked_client_count,0) ELSE NULL END AS linked_client_count
FROM credit.item i LEFT JOIN mapped m USING (report_date, institution_name, item_type);

CREATE VIEW credit.institution_usage AS
SELECT i.*, i.total_used AS imported_total_used,
  CASE WHEN u.unlinked_count > 0 THEN NULL ELSE coalesce(u.effective_sum,0) END AS effective_total_used,
  coalesce(u.unlinked_count,0) AS unlinked_usage_count
FROM credit.institution i LEFT JOIN (
  SELECT report_date,institution_name,sum(effective_used_amount) AS effective_sum,
    count(*) FILTER(WHERE usage_source='financing' AND linked_client_count=0) AS unlinked_count
  FROM credit.item_usage GROUP BY report_date,institution_name
) u USING(report_date,institution_name);

CREATE VIEW credit.usage_reconciliation AS
SELECT report_date, institution_name, item_type, imported_used_amount,
  effective_used_amount AS financing_used_amount,
  effective_used_amount - coalesce(imported_used_amount,0) AS difference,
  linked_client_count,
  CASE WHEN linked_client_count = 0 THEN 'unlinked'
    WHEN abs(effective_used_amount - coalesce(imported_used_amount,0)) > 0.0001 THEN 'mismatch'
    ELSE 'matched' END AS status
FROM credit.item_usage WHERE usage_source = 'financing';


CREATE OR REPLACE FUNCTION credit.refresh_institution_events()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM credit.institution_event;

  INSERT INTO credit.institution_event (
    report_date,
    previous_report_date,
    institution_name,
    institution_type,
    event_type,
    previous_status,
    current_status,
    previous_total_limit,
    current_total_limit,
    delta_amount,
    previous_effective_date,
    current_effective_date,
    previous_expiry_date,
    current_expiry_date,
    credit_details,
    updated_at
  )
  WITH report_dates AS (
    SELECT
      report_date,
      lag(report_date) OVER (ORDER BY report_date) AS previous_report_date
    FROM (
      SELECT DISTINCT report_date
      FROM credit.institution
    ) AS dates
  ),
  comparison_keys AS (
    SELECT
      dates.report_date,
      dates.previous_report_date,
      names.institution_name
    FROM report_dates AS dates
    CROSS JOIN LATERAL (
      SELECT institution_name
      FROM credit.institution
      WHERE report_date = dates.report_date
      UNION
      SELECT institution_name
      FROM credit.institution
      WHERE report_date = dates.previous_report_date
    ) AS names
    WHERE dates.previous_report_date IS NOT NULL
  ),
  comparisons AS (
    SELECT
      keys.report_date,
      keys.previous_report_date,
      keys.institution_name,
      current_record.institution_name AS current_institution_name,
      previous_record.institution_name AS previous_institution_name,
      COALESCE(current_record.institution_type, previous_record.institution_type) AS institution_type,
      previous_record.status AS previous_status,
      current_record.status AS current_status,
      previous_record.total_limit AS previous_total_limit,
      current_record.total_limit AS current_total_limit,
      previous_record.effective_date AS previous_effective_date,
      current_record.effective_date AS current_effective_date,
      previous_record.expiry_date AS previous_expiry_date,
      current_record.expiry_date AS current_expiry_date
    FROM comparison_keys AS keys
    LEFT JOIN credit.institution AS current_record
      ON current_record.report_date = keys.report_date
     AND current_record.institution_name = keys.institution_name
    LEFT JOIN credit.institution AS previous_record
      ON previous_record.report_date = keys.previous_report_date
     AND previous_record.institution_name = keys.institution_name
  ),
  classified AS (
    SELECT
      comparisons.*,
      CASE
        WHEN current_institution_name IS NOT NULL
          AND previous_institution_name IS NOT NULL
          AND current_status = 'revoked'::credit.credit_status
          AND previous_status IS DISTINCT FROM 'revoked'::credit.credit_status
          THEN 'revocation'
        WHEN current_institution_name IS NOT NULL
          AND previous_institution_name IS NOT NULL
          AND COALESCE(current_total_limit, 0) > COALESCE(previous_total_limit, 0) + 0.0001
          AND (
            current_status = 'approved'::credit.credit_status
            OR previous_status = 'approved'::credit.credit_status
          )
          THEN 'increase'
        WHEN current_institution_name IS NOT NULL
          AND previous_institution_name IS NOT NULL
          AND current_expiry_date IS NOT NULL
          AND current_expiry_date IS DISTINCT FROM previous_expiry_date
          AND (
            current_status = 'approved'::credit.credit_status
            OR previous_status = 'approved'::credit.credit_status
          )
          THEN 'renewal'
        WHEN current_status = 'approved'::credit.credit_status
          AND (
            previous_institution_name IS NULL
            OR previous_status IS DISTINCT FROM 'approved'::credit.credit_status
          )
          THEN 'new'
        WHEN previous_status = 'approved'::credit.credit_status
          AND current_institution_name IS NULL
          THEN CASE
            WHEN previous_expiry_date > previous_report_date
              AND previous_expiry_date <= report_date
              THEN 'expiry'
            ELSE 'revocation'
          END
        WHEN previous_status = 'approved'::credit.credit_status
          AND COALESCE(current_expiry_date, previous_expiry_date) > previous_report_date
          AND COALESCE(current_expiry_date, previous_expiry_date) <= report_date
          THEN 'expiry'
        ELSE NULL
      END AS event_type
    FROM comparisons
  )
  SELECT
    classified.report_date,
    classified.previous_report_date,
    classified.institution_name,
    classified.institution_type,
    classified.event_type,
    classified.previous_status,
    classified.current_status,
    classified.previous_total_limit,
    classified.current_total_limit,
    COALESCE(classified.current_total_limit, 0)
      - COALESCE(classified.previous_total_limit, 0),
    classified.previous_effective_date,
    classified.current_effective_date,
    classified.previous_expiry_date,
    classified.current_expiry_date,
    COALESCE(details.credit_details, '[]'::jsonb),
    now()
  FROM classified
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'type', item.item_type::text,
        'limitAmount', item.limit_amount::double precision,
        'details', item.details
      )
      ORDER BY array_position(
        ARRAY[
          'bond_investment',
          'yield_certificate',
          'legal_overdraft',
          'margin_income_rights',
          'interbank_lending',
          'other'
        ]::text[],
        item.item_type::text
      )
    ) AS credit_details
    FROM credit.item AS item
    WHERE item.report_date = CASE
        WHEN classified.current_institution_name IS NOT NULL
          THEN classified.report_date
        ELSE classified.previous_report_date
      END
      AND item.institution_name = classified.institution_name
      AND (
        item.limit_amount IS NOT NULL
        OR NULLIF(btrim(item.details), '') IS NOT NULL
      )
  ) AS details ON true
  WHERE classified.event_type IS NOT NULL;
END;
$$;

SELECT credit.refresh_institution_events();

REVOKE ALL ON TABLE credit.institution_client,credit.item_usage,credit.institution_usage,credit.usage_reconciliation FROM PUBLIC;
REVOKE ALL ON FUNCTION credit.link_institution_clients(),credit.set_institution_usage_sum(),credit.sync_item_usage_sum() FROM PUBLIC;

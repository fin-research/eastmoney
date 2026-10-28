-- Apply financing/0028_client_master.sql first.
CREATE TABLE credit.client_mapping (
  institution_name text NOT NULL,
  client_id bigint NOT NULL REFERENCES public.client(id) ON DELETE RESTRICT,
  yield_certificate boolean NOT NULL DEFAULT true,
  interbank_lending boolean NOT NULL DEFAULT true,
  notes text NOT NULL,
  PRIMARY KEY (institution_name, client_id)
);
CREATE UNIQUE INDEX client_mapping_yield_owner ON credit.client_mapping(client_id) WHERE yield_certificate;
CREATE UNIQUE INDEX client_mapping_lending_owner ON credit.client_mapping(client_id) WHERE interbank_lending;

CREATE TABLE credit.institution_client (
  report_date date NOT NULL,
  institution_name text NOT NULL,
  client_id bigint NOT NULL REFERENCES public.client(id) ON DELETE RESTRICT,
  yield_certificate boolean NOT NULL DEFAULT true,
  interbank_lending boolean NOT NULL DEFAULT true,
  PRIMARY KEY (report_date, institution_name, client_id),
  FOREIGN KEY (report_date, institution_name) REFERENCES credit.institution(report_date, institution_name) ON DELETE CASCADE
);
CREATE UNIQUE INDEX institution_client_yield_owner ON credit.institution_client(report_date, client_id) WHERE yield_certificate;
CREATE UNIQUE INDEX institution_client_lending_owner ON credit.institution_client(report_date, client_id) WHERE interbank_lending;

CREATE FUNCTION credit.link_institution_clients() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, credit AS $$
DECLARE candidate_ids bigint[]; candidate_count integer;
BEGIN
  INSERT INTO credit.institution_client (report_date, institution_name, client_id, yield_certificate, interbank_lending)
    SELECT NEW.report_date, NEW.institution_name, m.client_id, m.yield_certificate, m.interbank_lending
    FROM credit.client_mapping m WHERE m.institution_name = NEW.institution_name;
  IF NOT FOUND THEN
    SELECT array_agg(DISTINCT public.resolve_client(part)), count(*) INTO candidate_ids,candidate_count
    FROM regexp_split_to_table(NEW.institution_name, '[&＆]') part;
    -- A new clear name (or fully resolved combined name) can link automatically.
    -- Partial/ambiguous names remain unlinked and are reported, never partly summed.
    IF array_position(candidate_ids,NULL) IS NULL AND cardinality(candidate_ids)=candidate_count
      AND NOT EXISTS (SELECT 1 FROM credit.institution_client m WHERE m.report_date=NEW.report_date AND m.client_id=ANY(candidate_ids))
      AND NOT EXISTS (SELECT 1 FROM credit.client_mapping m WHERE m.client_id=ANY(candidate_ids)) THEN
      INSERT INTO credit.institution_client(report_date,institution_name,client_id)
        SELECT NEW.report_date,NEW.institution_name,unnest(candidate_ids);
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER link_institution_clients AFTER INSERT ON credit.institution
FOR EACH ROW EXECUTE FUNCTION credit.link_institution_clients();

-- Preserve any original unallocated balance while keeping later manual item edits
-- consistent with the total. Financing-derived items are never manually edited.
CREATE FUNCTION credit.sync_manual_usage_delta() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, credit AS $$
BEGIN
  IF NEW.item_type NOT IN ('yield_certificate','interbank_lending') THEN
    UPDATE credit.institution SET total_used=coalesce(total_used,0)+coalesce(NEW.used_amount,0)-coalesce(OLD.used_amount,0)
    WHERE report_date=NEW.report_date AND institution_name=NEW.institution_name;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sync_manual_usage_delta AFTER UPDATE OF used_amount ON credit.item
FOR EACH ROW WHEN (NEW.used_amount IS DISTINCT FROM OLD.used_amount) EXECUTE FUNCTION credit.sync_manual_usage_delta();

CREATE VIEW credit.item_usage AS
WITH dates AS (SELECT DISTINCT report_date FROM credit.institution),
financing_usage AS (
  SELECT dates.report_date, u.* FROM dates CROSS JOIN LATERAL financing.credit_usage_as_of(dates.report_date) u
), mapped AS (
  SELECT m.report_date, m.institution_name, t.item_type,
    count(DISTINCT m.client_id) AS linked_client_count,
    coalesce(sum(u.amount),0) / 100000000 AS financing_used
  FROM credit.institution_client m
  CROSS JOIN (VALUES ('yield_certificate'::credit.item_type), ('interbank_lending'::credit.item_type)) t(item_type)
  LEFT JOIN financing_usage u ON u.report_date = m.report_date AND u.client_id = m.client_id
    AND u.debt_type = CASE t.item_type WHEN 'yield_certificate' THEN '收益凭证' ELSE '同业拆借' END
    AND CASE t.item_type WHEN 'yield_certificate' THEN m.yield_certificate ELSE m.interbank_lending END
  GROUP BY m.report_date, m.institution_name, t.item_type
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
  CASE WHEN u.unlinked_count > 0 THEN NULL
    ELSE coalesce(i.total_used, u.imported_sum, 0) - coalesce(u.replaced_sum,0) + coalesce(u.financing_sum,0)
    END AS effective_total_used,
  coalesce(u.unlinked_count,0) AS unlinked_usage_count
FROM credit.institution i LEFT JOIN (
  SELECT report_date,institution_name,sum(used_amount) AS imported_sum,
    sum(used_amount) FILTER (WHERE usage_source = 'financing') AS replaced_sum,
    sum(effective_used_amount) FILTER (WHERE usage_source = 'financing') AS financing_sum,
    count(*) FILTER (WHERE usage_source = 'financing' AND linked_client_count = 0) AS unlinked_count
  FROM credit.item_usage u GROUP BY report_date,institution_name
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

REVOKE ALL ON TABLE credit.client_mapping, credit.institution_client,
  credit.item_usage, credit.institution_usage, credit.usage_reconciliation FROM PUBLIC;
REVOKE ALL ON FUNCTION credit.link_institution_clients() FROM PUBLIC;
REVOKE ALL ON FUNCTION credit.sync_manual_usage_delta() FROM PUBLIC;

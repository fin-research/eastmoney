CREATE TABLE credit.institution_event (
  report_date date NOT NULL,
  previous_report_date date NOT NULL,
  source_row integer NOT NULL CHECK (source_row >= 4),
  institution_name text NOT NULL CHECK (btrim(institution_name) <> ''),
  institution_type text NOT NULL CHECK (btrim(institution_type) <> ''),
  event_type text NOT NULL CHECK (
    event_type IN ('new', 'renewal', 'increase', 'expiry', 'revocation')
  ),
  previous_status credit.credit_status,
  current_status credit.credit_status,
  previous_total_limit numeric(20, 6),
  current_total_limit numeric(20, 6),
  delta_amount numeric(20, 6) NOT NULL,
  previous_effective_date date,
  current_effective_date date,
  previous_expiry_date date,
  current_expiry_date date,
  credit_details jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(credit_details) = 'array'
  ),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report_date, institution_name)
);

CREATE INDEX credit_institution_event_recent_idx
  ON credit.institution_event (report_date DESC, event_type, source_row);

COMMENT ON TABLE credit.institution_event IS
  '相邻授信报表日之间的机构级新增、续作、扩额、到期和撤销事件';
COMMENT ON COLUMN credit.institution_event.credit_details IS
  '事件发生时各授信分项的额度和批复说明快照';

CREATE OR REPLACE FUNCTION credit.refresh_institution_events()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM credit.institution_event;

  INSERT INTO credit.institution_event (
    report_date,
    previous_report_date,
    source_row,
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
        AND included_in_weekly_report
      UNION
      SELECT institution_name
      FROM credit.institution
      WHERE report_date = dates.previous_report_date
        AND included_in_weekly_report
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
      COALESCE(current_record.source_row, previous_record.source_row) AS source_row,
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
     AND current_record.included_in_weekly_report
    LEFT JOIN credit.institution AS previous_record
      ON previous_record.report_date = keys.previous_report_date
     AND previous_record.institution_name = keys.institution_name
     AND previous_record.included_in_weekly_report
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
    classified.source_row,
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

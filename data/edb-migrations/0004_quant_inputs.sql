-- Raw model inputs are separate from financing_model run outputs and public EDB IDs.
CREATE TABLE public.quant_input (
  dataset text NOT NULL,
  entity_key text NOT NULL DEFAULT '',
  field text NOT NULL,
  observation_date date NOT NULL,
  numeric_value double precision,
  text_value text,
  published_date date,
  source text NOT NULL,
  source_key text NOT NULL,
  source_hash text NOT NULL,
  first_ingested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  synced_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (dataset, entity_key, field, observation_date),
  CHECK (btrim(dataset) <> '' AND btrim(field) <> ''),
  CHECK ((numeric_value IS NULL) <> (text_value IS NULL)),
  CHECK (numeric_value IS NULL OR (numeric_value > '-Infinity'::float8 AND numeric_value < 'Infinity'::float8))
);
CREATE INDEX quant_input_date_idx ON public.quant_input(dataset, observation_date);
COMMENT ON TABLE public.quant_input IS 'Normalized source inputs, not derived features; field units and mappings owned by quant-input-contract.ts. Missing values are absent, never synthetic zeros.';
COMMENT ON COLUMN public.quant_input.published_date IS 'Actual source release date if known. NULL for legacy workbooks; never infer publication from observation or import time.';

CREATE TABLE public.quant_input_sync (
  source_key text PRIMARY KEY,
  source_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('complete','partial','failed')),
  row_count integer NOT NULL DEFAULT 0,
  detail text NOT NULL DEFAULT '',
  synced_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE public.quant_input_sync IS 'Per-source refresh evidence; complete only means this source was processed, not that all model inputs are available.';

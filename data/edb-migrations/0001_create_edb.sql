CREATE TABLE IF NOT EXISTS public.edb (
  indicator_code text NOT NULL,
  observation_date date NOT NULL,
  value numeric NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (indicator_code, observation_date),
  CONSTRAINT edb_indicator_code_not_blank CHECK (btrim(indicator_code) <> '')
);

CREATE INDEX IF NOT EXISTS edb_observation_date_idx
  ON public.edb (observation_date DESC);

COMMENT ON TABLE public.edb IS
  'Choice EDB raw observations populated only by the manual dashboard sync command';

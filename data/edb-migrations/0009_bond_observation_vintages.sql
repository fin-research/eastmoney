-- Preserve future observed versions without pretending imported history was PIT.
CREATE TABLE public.bond_history_request (
  request_hash text PRIMARY KEY,
  valuation_date date NOT NULL,
  codes text[] NOT NULL,
  parameters jsonb NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  received_at timestamptz,
  response_hash text,
  response jsonb,
  status text NOT NULL CHECK (status IN ('pending','received','applied','failed')),
  detail text
);
CREATE TABLE public.bond_history_version (
  bond_code text NOT NULL,
  valuation_date date NOT NULL,
  recorded_at timestamptz NOT NULL,
  chinabond_yield_pct double precision,
  outstanding_balance_cny double precision CHECK (outstanding_balance_cny >= 0),
  remaining_term_years double precision CHECK (remaining_term_years >= 0),
  request_hash text NOT NULL REFERENCES public.bond_history_request,
  PRIMARY KEY (bond_code, valuation_date, request_hash)
);
CREATE INDEX bond_history_version_asof_idx ON public.bond_history_version
  (valuation_date, bond_code, recorded_at DESC);
COMMENT ON COLUMN public.bond_history_version.recorded_at IS
  'Observed availability time. Historical imports have no reconstructed first-release vintage.';
ALTER TABLE public.bond_issuance ADD COLUMN maturity_date date;
ALTER TABLE public.bond_issuance ADD COLUMN placement_source_hash text;
ALTER TABLE public.bond_issuance ADD COLUMN placement_recorded_at timestamptz;

CREATE TABLE public.bond_placement_request (
  request_hash text PRIMARY KEY,
  codes text[] NOT NULL,
  issue_dates jsonb NOT NULL,
  parameters jsonb NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  received_at timestamptz,
  response jsonb,
  status text NOT NULL CHECK (status IN ('pending','received','applied','failed'))
);

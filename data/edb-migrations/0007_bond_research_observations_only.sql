-- Keep research-input tables at their observation grain. File provenance is
-- recorded in import run output, not repeated on every bond-day or curve node.
ALTER TABLE public.bond_history
  DROP COLUMN IF EXISTS yield_source,
  DROP COLUMN IF EXISTS balance_source,
  DROP COLUMN IF EXISTS term_source,
  DROP COLUMN IF EXISTS source_snapshot_at,
  DROP COLUMN IF EXISTS last_imported_at;

ALTER TABLE public.bond_industry_curve
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS source_snapshot_at,
  DROP COLUMN IF EXISTS last_imported_at;

COMMENT ON COLUMN public.bond_history.outstanding_balance_cny IS
  'Raw outstanding balance in yuan; NULL means the observation was unavailable.';

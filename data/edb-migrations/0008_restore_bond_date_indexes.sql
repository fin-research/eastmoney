-- 0006 is recorded as applied in production, but these two date indexes are
-- absent there. Keep 0006 immutable and repair the live schema idempotently.
CREATE INDEX IF NOT EXISTS bond_history_date_idx
  ON public.bond_history (valuation_date DESC, bond_code);
CREATE INDEX IF NOT EXISTS bond_industry_curve_date_idx
  ON public.bond_industry_curve (observation_date DESC, curve_code);

ANALYZE public.bond_history;
ANALYZE public.bond_industry_curve;

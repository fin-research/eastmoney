-- Per-source exclusions are set only after a singleton CSS request returns 10003008.
-- Keep issue facts and existing valuation history; explicit maintenance can clear a flag.
ALTER TABLE public.bond_issuance ADD COLUMN placement_invalid_code boolean NOT NULL DEFAULT false;
ALTER TABLE public.bond_issuance ADD COLUMN history_invalid_code boolean NOT NULL DEFAULT false;

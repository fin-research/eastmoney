-- Actual issuance is an announcement-backed source fact, separate from SDK code validity.
ALTER TABLE public.bond_issuance
  ADD COLUMN actual_issuance_status text NOT NULL DEFAULT 'unknown',
  ADD COLUMN actual_issuance_source_url text,
  ADD COLUMN actual_issuance_source_sha256 text,
  ADD COLUMN actual_issuance_announcement_date date,
  ADD COLUMN actual_issuance_recorded_at timestamptz,
  ADD CONSTRAINT bond_actual_issuance_evidence CHECK (
    actual_issuance_status IN ('unknown','issued','not_issued') AND
    (actual_issuance_status='unknown' OR (
      actual_issuance_source_url ~ '^https://[^[:space:]]+$' AND
      actual_issuance_source_sha256 ~ '^[0-9a-f]{64}$' AND
      actual_issuance_announcement_date IS NOT NULL AND actual_issuance_recorded_at IS NOT NULL
      AND actual_issuance_source_url IS NOT NULL AND actual_issuance_source_sha256 IS NOT NULL)));

CREATE FUNCTION public.protect_bond_actual_issuance_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.actual_issuance_status<>'unknown' AND (
    NEW.bond_code IS DISTINCT FROM OLD.bond_code OR NEW.issue_date IS DISTINCT FROM OLD.issue_date OR
    NEW.original_tenor_years IS DISTINCT FROM OLD.original_tenor_years OR
    NEW.short_name IS DISTINCT FROM OLD.short_name OR NEW.issuer_name IS DISTINCT FROM OLD.issuer_name) THEN
    RAISE EXCEPTION 'Announcement-backed issuance identity conflicts with refresh for %', OLD.bond_code;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_bond_actual_issuance_identity BEFORE UPDATE ON public.bond_issuance
  FOR EACH ROW EXECUTE FUNCTION public.protect_bond_actual_issuance_identity();

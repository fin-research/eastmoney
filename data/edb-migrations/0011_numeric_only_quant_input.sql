-- All remaining quant_input observations are numeric. Bond-level text facts
-- already live in bond_issuance. Refuse to discard text in older databases.
DO $$
DECLARE has_text_values boolean;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'quant_input' AND column_name = 'text_value'
  ) THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.quant_input WHERE text_value IS NOT NULL)'
      INTO has_text_values;
    IF has_text_values THEN
      RAISE EXCEPTION 'quant_input still contains text values';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.quant_input WHERE numeric_value IS NULL) THEN
    RAISE EXCEPTION 'quant_input still contains null numeric values';
  END IF;
END $$;

ALTER TABLE public.quant_input DROP COLUMN IF EXISTS text_value;
ALTER TABLE public.quant_input ALTER COLUMN numeric_value SET NOT NULL;
COMMENT ON TABLE public.quant_input IS 'Numeric market and company observations by field/date. Issue facts live in bond_issuance; missing values have no row. On overlapping company LCR/NSFR dates, the fund report wins.';

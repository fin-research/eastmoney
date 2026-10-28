ALTER TABLE public.edb
  ADD COLUMN observation_date date;

UPDATE public.edb
SET observation_date = published_date
WHERE observation_date IS NULL;

ALTER TABLE public.edb
  ALTER COLUMN observation_date SET NOT NULL;

ALTER TABLE public.edb
  DROP CONSTRAINT edb_pkey;

ALTER TABLE public.edb
  ADD PRIMARY KEY (indicator_code, observation_date);

COMMENT ON COLUMN public.edb.observation_date IS
  'Choice EDB statistical period date used to identify each observation';

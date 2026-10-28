ALTER TABLE public.edb
  RENAME COLUMN observation_date TO published_date;

ALTER INDEX IF EXISTS public.edb_observation_date_idx
  RENAME TO edb_published_date_idx;

COMMENT ON COLUMN public.edb.published_date IS
  'Choice EDB release date returned with IsPublishDate=1';

COMMENT ON TABLE public.edb IS
  'Choice EDB release-date series populated only by the manual dashboard sync command';

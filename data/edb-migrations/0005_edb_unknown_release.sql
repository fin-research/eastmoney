-- Some pre-2020 Choice observations have no release metadata. Preserve them
-- without inventing a publication date; existing release-date readers exclude NULL.
ALTER TABLE public.edb ALTER COLUMN published_date DROP NOT NULL;
COMMENT ON COLUMN public.edb.published_date IS 'Actual source release date; NULL when historical release metadata is unavailable. Never substitute observation_date for a missing macro release date.';

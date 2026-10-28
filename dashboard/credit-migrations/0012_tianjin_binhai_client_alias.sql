SELECT pg_advisory_xact_lock(hashtext('financing.local_debt_maintenance'));
SELECT pg_advisory_xact_lock(hashtextextended('credit.excel_import',0));
INSERT INTO public.client(name,type) VALUES('天津滨海农商行','银行') ON CONFLICT(name) DO NOTHING;
INSERT INTO public.client_alias(alias,client_id)
SELECT public.client_match_key('天津滨海农村商行'),id FROM public.client WHERE name='天津滨海农商行'
ON CONFLICT(alias) DO NOTHING;
DO $$ BEGIN
  IF public.resolve_client('天津滨海农村商行') IS DISTINCT FROM (SELECT id FROM public.client WHERE name='天津滨海农商行') THEN
    RAISE EXCEPTION '天津滨海农村商行别名已有不同客户归属';
  END IF;
END $$;
UPDATE financing.debt SET client_id=public.resolve_client(counterparty)
WHERE client_id IS NULL AND public.client_match_key(counterparty)=public.client_match_key('天津滨海农村商行');

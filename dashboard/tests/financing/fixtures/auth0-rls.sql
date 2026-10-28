-- Run only on a migration validation branch. All changes roll back.
BEGIN;
UPDATE financing.people SET auth0_account_active=TRUE,
  auth0_permissions=ARRAY['data_manage'], auth0_authorized_until=CURRENT_TIMESTAMP + interval '60 seconds'
WHERE role='admin';
SELECT set_config('request.financing.user_id',(SELECT auth0_user_id FROM financing.people WHERE role='admin' ORDER BY id LIMIT 1),true);
SET LOCAL ROLE authenticated;
SELECT financing.current_app_user_can_edit() AS authorized;
RESET ROLE;
UPDATE financing.people SET auth0_authorized_until=CURRENT_TIMESTAMP - interval '1 second' WHERE role='admin';
SET LOCAL ROLE authenticated;
SELECT financing.current_app_user_can_edit() AS expired_authorized, (SELECT count(*) FROM financing.debt) AS visible_rows;
RESET ROLE;
ROLLBACK;

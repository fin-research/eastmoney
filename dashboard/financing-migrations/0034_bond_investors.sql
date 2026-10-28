BEGIN;

CREATE TABLE financing.bond_investors (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bond_id bigint NOT NULL REFERENCES financing.bond(id) ON DELETE CASCADE,
  investor_id bigint REFERENCES public.client(id) ON DELETE RESTRICT,
  channel text CHECK (channel IS NULL OR btrim(channel) <> ''),
  account text CHECK (account IS NULL OR btrim(account) <> ''),
  amount numeric(20,2) NOT NULL CHECK (amount > 0 AND amount <> 'NaN'::numeric),
  UNIQUE NULLS NOT DISTINCT (bond_id, investor_id, channel, account)
);
CREATE INDEX bond_investors_investor_idx ON financing.bond_investors(investor_id);
COMMENT ON TABLE financing.bond_investors IS '一级发行投资人分配；同一债券、投资人、通道、账户合并金额，不代表二级市场持仓';
COMMENT ON COLUMN financing.bond_investors.amount IS '认购金额，单位元';
COMMENT ON COLUMN financing.bond_investors.investor_id IS '实际投资人关联 public.client；来源明确为未知时为空，不按通道或产品管理人推断';
COMMENT ON COLUMN financing.bond_investors.channel IS '来源通道方（如有）；不使用销售渠道列';
COMMENT ON COLUMN financing.bond_investors.account IS '来源产品名称或承销商/产品名称原文；缺失保持空';

ALTER TABLE financing.bond_investors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON financing.bond_investors FROM PUBLIC;
GRANT SELECT ON financing.bond_investors TO authenticated;
CREATE POLICY permission_read ON financing.bond_investors FOR SELECT TO authenticated
  USING ("authorization".has_permission('financing.data:read'));

COMMIT;

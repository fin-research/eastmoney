# 债券投资人

入口 `/financing/bond-investors`，页面只读。MCP 专用工具按 `financing.data:read` 读取债券、既有分配和机构目录；逐条新增、修改按 `financing.data:create/update` 授权。机构维护复用客户新增和修改操作。工具不开放通用表写入。

## 数据与口径

- `financing.bond_investors` 由融资 migration `0034` 管理，`bond_id` 外键指向实际继承子表 `financing.bond`，`investor_id` 关联 `public.client`。数据库金额单位元，页面单位亿元。
- 同一债券、投资人、通道、账户构成唯一分配，空值参与去重。同键多条源记录合并金额。金额必须大于零且有限。删除债券级联清理分配，已被引用客户禁止删除。
- `channel` 读取通道方列，`account` 读取产品名称或承销商/产品名称列。短融的“销售渠道”不替代通道方。来源账户缺失保持 NULL。未知实际投资人保持 NULL，不按通道、管理人或金额猜测，也不建立虚拟客户。
- 累计规模为2020年起至统计日已起息债券的一级发行认购金额。存续规模再要求 `maturity_date > 统计日`，且尚未结清/关闭。到期当天不计存续，历史截面不使用当前 `status`。本表不能代表二级市场转让后的实际持仓。授信表将其按实际投资人及静态机构关联汇总为一级发行存续额，再加授信登记的二级买卖净余额，具体公式与历史迁移见 [授信工作台](credit-workbench.md)。
- 四品种依次为公募债（小公募）、公募次级债（次级债）、私募债、短融（短期融资券）。机构类型由客户 `type/subtype` 派生。银行资管与理财子均属银行理财，城商行与农商行合并为城农商行。
- 分类汇总、分品种占比、投资人排名共用服务器分组查询。占比分母为相同统计日与所选品种的完整累计/存续金额，零分母显示“—”。页面不下载 Excel、不下发账户原文。

## 页面

五组模块依次为累计融资、存续融资、累计机构类型分布、存续机构类型分布、具体投资人。桌面左图右表，窄屏先图后表。三个分品种选择器独立，具体投资人支持累计/存续排序，完整名单均可滚动查看。图表复用 ChartHost 和融资图表配置，表格使用相同数据。空范围显示空状态，未登记明细或分配合计与本金不符时显示债券覆盖缺口。

## 本地历史导入

先在隔离数据库分支执行融资 migration 并检查约束、回滚与现有数据，再在目标库按相同 migration ledger 应用。导入使用本地固定副本与 SHA-256 留证，原始 Excel、客户修订清单和核对输出不进入 Git。

```sh
node --env-file=.env.database scripts/financing/import-bond-investors.mjs --file /absolute/source.xlsx --report /absolute/preview.json
node --env-file=.env.database scripts/financing/import-bond-investors.mjs --file /absolute/source.xlsx --report /absolute/applied.json --apply
node --use-env-proxy scripts/financing/verify-bond-investors.mjs --expected /absolute/applied.json --output /absolute/online.json
```

默认事务回滚预览，`--apply` 才提交。事务 advisory lock 串行化投资人导入。债券按唯一简称及品种关联，每只认购合计必须等于既有发行本金，源表分组小计也必须相等。日期与主表不同单独报告，不自动改写主表。现有债券分配只允许完全一致的重跑，不覆盖、删除或补写不同分配。

客户复用 `public.resolve_client`，新客户按表内机构分类建立，法律全名缺失保持 NULL。银行资管使用现有银行规范简称加“资管”。已有客户分类不同会拒绝导入。经核对的修订通过 `--client-corrections` 提供精确的 `name/fromType/fromSubtype/toType/toSubtype` 清单，不批量覆盖客户资料。

核对结果包含源行数、合并后分配数、客户映射、债券数/金额/日期差异、机构和分类逐格对账、统计页公式表及静态表差异。主汇总与按投资机构表不一致时回滚。统计页排名引用缺漏、静态副本过时仅记录差异，以完整明细计算结果展示。

验证：`tests/financing/bond-investors.test.mjs` 覆盖源表小计、账户映射、幂等导入、事务回滚、外键、唯一约束、金额、只读 RLS、日期边界与客户资管身份。交付还需默认检查与线上同一统计日 HTTP 数据核对。

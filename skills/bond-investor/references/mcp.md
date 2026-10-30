# Eastmoney MCP 调用

宿主工具名可能带服务器前缀，按短名发现后查看实际 schema。MCP 只提供查询与原子记录维护；本地生成、审核和提交操作清单，不调用线上草稿或审核服务。

## 参考数据

`bond_investor_reference`：

```json
{"query":{"bondName":["目标债券简称"]}}
```

读取债券本金/品种/日期、既有分配和客户目录。`financing_clients` 支持 `query.q` 搜索客户名称、全名或别名，返回 `id`、`version` 及现有字段。通过真实目录复用机构，不能因简称不同直接新建。

## 客户维护

复用 `create_client` 和 `update_client`，参数放在 `form`：`name`、`fullname`、`type`、`subtype`、`aliases`（换行分隔）；修改还需真实 `id` 和当前 `version`。未知法律全名留空。更新携带当前完整资料，不能清空已有别名。客户类型限银行、理财子、券商、基金、营业部客户、其它，子类型沿用实际目录规范。

```json
{"form":{"name":"已审核规范简称","fullname":"","type":"基金","subtype":"公募基金","aliases":"已审核别名"}}
```

创建前查询相同名称/别名；返回 `failed`、`isError` 或业务失败均不得继续分配。

## 投资记录增改

使用 `create_bond_investor` 和 `update_bond_investor`，金额单位元；`account` 是登记表证券账户名称完整原文，`channel` 为空时传 NULL。投资人使用已核对的客户身份，不用通道代替；从参考响应取得债券及记录标识。修改携带查询所得原值或版本作为并发条件，不能省略。

新增示例（金额及名称仅表示参数结构）：

```json
{"body":{"bondName":"目标债券简称","investorName":"已审核机构简称","channel":null,"account":"登记表产品原文","amount":10000000}}
```

修改示例：

```json
{"body":{"id":"实际记录ID","oldBondName":"目标债券简称","oldInvestorName":"原投资人简称","oldChannel":null,"oldAccount":"原产品原文","oldAmount":10000000,"investorName":"已审核机构简称","channel":"已审核通道简称","account":"登记表产品原文","amount":10000000}}
```

原投资人未知时 `oldInvestorName` 为 NULL；原金额从响应的十进制元字符串转换，确保仍为整数分。修改不跨债券。

按实际工具 schema 组装精确参数并保存本地操作清单，先审核再逐条发送。服务端单条事务不保存整批草稿；完成后重新查询、逐笔对账，并核对整债总额与本金相等。工具未上线时不能声称已通过该入口上传。

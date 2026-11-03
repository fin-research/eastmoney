# Choice 原生协议迁移

本分支把 Choice 会话迁到 `ChoiceSession` Durable Object。
Data 的六个函数及公开表格契约保持不变。
办公室 C++ RPC 不再是本分支的调用通道。
此实现仍在离线验证，尚未部署。

## 会话和协议

每个授权账号由一个对象持有会话。
对象串行处理查询，独立维持心跳。
收到有效心跳回复后，登录才算完成。
登录失败或网络超时不会自动重发数据查询。
账号被踢后暂停登录，需管理员恢复。

CSD、CSS、CTR、EDB 和交易日使用厂商 TCP 帧。
额度与权限等辅助请求使用厂商 HTTPS 接口。
发送头为 14 字节，接收头为 13 字节。
响应支持 gzip 和厂商类型化表格。
厂商 SDK、服务器清单、真实数据和凭据不进入公开仓库。

代码来自 Linux SDK 的离线分析。
目标 SHA-256：

```text
267c87809fed6b0de68720da662e098d2db07432626eeb7cf3e8915f78e15e26
```

REA 导出符号证据为 `ev_14523cc82314cce3100d78c25f819938efe15b2503b677fabb3cd83cbadcc4b0`。
请求帧证据为 `ev_a94056812b6b1c6a16eac4be0e29dd128e9fad0eb1829b8e40b47fccf5dcff04`。
SDK 纯解码函数已用于对照人工合成表格。
这些证据不代表真实登录、服务端权限或网络可达性验证。

## 配置与恢复

`CHOICE_SESSION` 是本 Worker 的私有对象绑定。
`CHOICE_CREDENTIALS` 和 `CHOICE_SERVERS` 必须配置为 Worker Secrets。
不得把它们写入 Wrangler vars、日志或测试夹具。

`CHOICE_SERVERS` 提供 2、3、6、19、20 类服务地址。
各地址包含 `hostname` 和 `port`。
`statisticsOrigin` 是厂商权限服务的 HTTPS origin。
从当前私有 SDK 清单确认地址，不复制历史 IP。

凭据支持 `auto` 和 `password` 两种模式。
自动模式包含 `uid`、`ctoken`、`utoken`。
密码模式包含 `account`、`password`。
两种模式均须明确提供 `deviceId` 和 `deviceModel`。
迁移预激活凭据时保留原设备标识。
密码登录是否获账号授权仍须实测。

对象保存登录后轮换的激活凭据。
对象将这些凭据与账号、设备指纹绑定。
更换身份时拒绝复用旧会话。
管理员可经私有对象绑定调用 `reset()`。
该操作关闭旧连接并清理持久状态。
公网 HTTP 没有恢复入口。

## 费用

出站 TCP 不支持 WebSocket 休眠优化。
心跳间隔约为 15 秒。
一个账号连续运行 30 天约有 17.28 万次定时唤醒。
实际查询、重连和存储另计。

按官方例子的 128 MB 口径，连续运行约为 331,776 GB-s。
Workers Paid 当前包含每月 400,000 GB-s 的 DO duration。
额度有剩余时，此对象的 duration 可被覆盖。
超出额度按每百万 GB-s 12.50 美元计费。
未抵扣额度的 duration 约为每月 4.15 美元。

Workers Paid 最低套餐费用为每月 5 美元。
其他服务共享额度，不能据此承诺账单为零。

费用依据：[Cloudflare DO 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)。
连接行为依据：[TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)。
部署前须重新查询价格及账号剩余额度。

## 发布前验证

先完成协议回放、生命周期测试、类型检查和 Worker dry-run。
真实验证前执行[Choice 额度计划](../../../docs/CHOICE.md)。
核对账号、设备绑定、权限和当前上游额度。
确认 Cloudflare 到厂商 TCP 地址的可达性。
验证百分数字段、日期补齐、额度回报及六个函数的口径。
记录生产 CPU 和 DO duration，再判断资源预算。

当前离线测试不证明生产 CPU 符合 10 ms 限制。
用户仅授权实现和离线验证，未授权本次直接部署。

## WIP 检查点

本提交用于保存已完成的原生会话与协议实现，不用于发布。
当前未接入已恢复的 EDB 发布时间辅助查询及完整旧版编码兼容路径。
`/workspace/work/choice-native-draft` 保留进一步恢复的离线草稿。
先合入草稿并补充回归，再开始真实账户验证。

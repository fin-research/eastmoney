# 管理中心与账号

入口：`/management/me`、`/management/permissions`、`/management/notifications`，管理员另有 `/management/people`、`/management/messenger`（见 [通知管理](messenger.md)）。`/management`、`/profile`、`/management/financing-profile` 重定向到“我的”，`/financing/settings` 经 `/profile` 到同处，`/financing/avatar` 返回 410。

身份、令牌、角色缓存和 `AUTHORIZATION_MODE` 见 [共享 AUTH](../../../docs/AUTH.md)，应用层约束见 [SECURITY](../SECURITY.md)。

## 职责

- Gateway 负责认证、缓存的角色授权和账号目录，Dashboard 只保留页面。
- Auth0 管理用户、角色、成员关系、姓名、部门、邮箱、停用状态和密码。应用不建人员表、角色表和成员表。
- 融资项目负责人、任务执行人、周报生成人保存 Auth0 用户 ID，SOP 默认角色保存 Auth0 角色 ID。姓名和角色从请求内的 Gateway 目录解析，不按邮箱或姓名自动绑定。

## 页面

- 导航上方“我的、权限、通知”面向所有登录用户。分割线下“通知管理、人员与角色、资金日报”仅 admin 可见，Gateway 同时校验 admin，普通业务 scope 不能替代角色。
- 门户“管理”卡片进入“我的”。管理页使用全站工作台外壳和 shadcn-svelte Maia，不依赖融资模块的样式作用域。
- `/management/me`：可改姓名和部门，保留邮箱、密码和行情偏好操作。保存后更新当前浏览器的账号展示。完整重载按登录时签名的声明显示，重新登录后才是最新值。
- `/management/permissions`：读取当前账号的角色和有效权限，用统一授权结果展示。
- `/management/people`：header 标签页“人员”（默认）与“角色”（`?tab=roles`）。管理员可改人员姓名、部门，角色及成员关系只在 Auth0 控制台维护，角色页只读。
  - 人员资料由浏览器同源请求 Gateway `/api/management/people` 读写，需 admin，目标须是本站组织成员且为 `eastmoney-email` 连接，写入只接受 ID、姓名、部门。
  - 名单只显示姓名，右侧编辑姓名和部门，桌面两面板等高，名单内部滚动。加载期间保持等高占位，失败提供重试。窄屏按目录、资料单列排列。
  - 角色页仅在打开时加载角色配置。
- 全站个人入口显示图标、姓名和部门，读根 layout 的客户端 context。

## 个人信息接口

- `GET /api/profile`、`POST /api/profile`（`account.profile:update`）只操作已验证的 Auth0 ID，每次读写核对当前账号、邮箱和连接。本人只能改姓名和 `user_metadata.department`。
- 改 18.cn 邮箱和重置密码沿用白名单与本人确认流程：改邮箱后须重新登录，密码只经 Auth0 邮件重置。
- 身份展示直接来自 access token 的 `username/email/department/picture/role/_roles`。`GET /auth/permissions` 返回权限及更新时间，并确认 Bearer 有效。

## 登录与操作预检

- 根 layout 挂载唯一 `LoginDialog`。匿名用户点击受保护页面、原生表单或已登记 API 操作时，前端先读共享会话快照。需要登录则打开站内提示框，权限不足则发全局消息。
- 提示框按钮打开登录弹窗，Auth0 SPA SDK 完成授权码 + PKCE，再用 Bearer 请求 `/auth/permissions` 校验。成功后更新展示，经 `goto` 继续原页面并保留输入。
- 弹窗被拦截、取消、失败或超时时，保留原页和输入并可重试。受保护直达静默恢复失败时走 SDK redirect。
- Auth0 拒绝响应的错误码和消息按纯文本显示在原页提示框，并提供重新登录，不结束待登录操作。这些信息不写入 URL、日志或持久存储。
- 直达登录回调只在当前内存保留这些信息和安全返回位置，不自动重试。
- 预检复用 Gateway 生成的路径、方法和 named action 权限契约，不替代服务端授权。后台 401 时读取最多重试一次，写入不自动重发。后台 403 就地提示并更新权限快照。
- access token 只在 SDK 内存缓存，不用登录 Cookie。刷新后由 Auth0 SSO 静默恢复，失败则重新授权。退出由 SDK 清除内存并退出 Auth0。

## 权限控件

- 用 `permission-visibility.ts`、`Button` 的 permission 属性和路由契约控制入口可见性。门户受保护卡片只按共享客户端授权快照显示，快照未确定前不显示。`WorkbenchShell` 自动过滤无权页面。
- 原生链接、表单和 `data-permission` 控件由 `auth-controls.ts` 同步隐藏并移除焦点，保留请求前置检查。新增写控件必须声明权限。
- 服务端准入由 Gateway 负责，前端隐藏只为交互。

## 通知

- `/management/notifications` 经 `/api/notifications/settings` 管理独立联系邮箱、Telegram Chat ID 和三类通知的渠道选择。`/api/notifications/push` 注册或移除本人设备。
- Workflow 通知只向管理员开放，交易/融资订阅需相应业务读取权限。服务端用 `locals.user` 的 Auth0 ID，不接收客户端指定的用户。
- PWA manifest 与 service worker 是公开静态资产。Service Worker 只缓存离线页和图标，不缓存登录态页面和 API。
- Push 在后台展示，设置 `requireInteraction: true` 请求保留到用户点击或关闭，点击只跳本站地址。macOS 要让横幅持续显示，需把 Chrome 通知设为持续提醒。
- 启用当前设备必须由用户点击授权，页面加载时不请求通知权限。

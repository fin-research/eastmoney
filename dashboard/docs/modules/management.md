# 管理中心与账号

入口：`/management/me`、`/management/permissions`、`/management/notifications`。管理员使用 `/management/people`、`/management/messenger`。旧 `/management`、`/profile` 重定向到“我的”。身份与授权公共规则见 [SECURITY](../SECURITY.md)。

## 统一职责

- Gateway 负责认证、缓存角色授权及账号目录，Dashboard 保留页面。角色权限由 Auth0 配置，内部读取通过私有服务。
- Auth0 管理用户、角色、角色成员、姓名、部门、邮箱、停用状态和密码。应用不创建或维护人员表、角色表和成员关系表。
- 权限代码格式为 `<domain>.<resource>:<action>`，目录和路由准入由 Gateway 维护。存储与缓存规则见 [共享 AUTH](../../../docs/AUTH.md)。
- `/management/people` 通过“人员”“角色”两个 header 标签页分别展示本组织人员资料和角色权限，默认人员，可用 `?tab=roles` 直接进入角色。管理员可在站内修改人员姓名、部门。角色及成员关系仍在 Auth0 控制台维护。
- 融资项目负责人、任务执行人、周报生成人直接保存 Auth0 用户 ID。SOP 默认角色保存 Auth0 角色 ID。姓名和角色从请求内 Gateway 目录解析，不按邮箱或姓名自动绑定。
- 原融资人员、权限、审计表及运行时审计流程已移除。审计后续独立规划。

## 角色权限配置

- 用户、角色、成员关系和业务权限统一由 Auth0 管理。
- Gateway 按已验证 JWT 的角色读取 Cache API 授权 JSON，TTL 为一小时。
- 仅使用 `AUTHORIZATION_MODE=enforce`。未知模式失败关闭，无内测旁路。
- 角色标签页只展示当前角色及权限，编辑通过 Auth0 控制台完成。
- 管理员缓存刷新要求同源和 `admin`，只刷新当前边缘节点。
- 其他节点到期后按需更新。角色成员变更须重新签发 token。
- 旧 `authorization` 表与 migration 仅供历史回溯，不参与运行时授权。

## 个人信息

- 身份展示直接来自当前 access token 的 `username/email/department/picture/role/_roles`，角色名称数组只用 `_roles`，`role` 保留数据库字符串。`GET /auth/permissions` 仅返回权限及更新时间并确认 Bearer 有效。不再使用 `/auth/session` 或旧 token 格式。
- `/management/me` 和 `GET /api/profile` 使用既有本人资料边界。`POST /api/profile` 使用 `account.profile:update`。
- 个人信息仅操作已验证的 Auth0 ID。每次读写核对当前账号、邮箱和连接。本人可修改姓名及 `user_metadata.department`，不接受目标用户 ID、角色、权限或 app_metadata。
- 管理员人员资料由浏览器同源请求 Gateway 公网 `/api/management/people` 读取和写入，需 admin，目标必须是本站 Auth0 组织成员和 `eastmoney-email` 连接。写入只接受 ID、姓名、部门。Gateway 先核对组织成员，再以 Auth0 用户聚合搜索取姓名和部门。搜索缺漏时才逐个回退。完整目录契约仍提供角色给融资等调用方。
- 修改姓名、18.cn 邮箱及密码重置仍使用原有白名单和本人确认流程。修改邮箱后要求重新登录。密码只通过 Auth0 邮件重置。
- 权限显示使用统一授权结果，展示当前有效权限，不再展示旧 Auth0 融资权限或硬编码通用权限。
- `/management/financing-profile` 和 `/financing/settings` 跳转 `/profile`。旧 `/financing/avatar` 返回 410。融资不再维护独立姓名和头像。

## 页面与入口

- 首页提供独立“管理”模块，进入“我的”。管理导航按登录身份与 admin 边界展示。管理使用全站工作台外壳和 shadcn-svelte Maia，不依赖融资模块的样式作用域。
- 角色标签页为角色目录加只读权限区，仅在打开时加载角色配置。人员标签页的名单只显示姓名，右侧编辑姓名和部门，两张面板在桌面等高，名单内部滚动。人员资料由浏览器直接从 Gateway 加载，期间保持等高占位，失败时提供重试。窄屏按目录、资料顺序单列排列。
- 全站个人入口显示图标、姓名和部门，读取根 layout 的客户端 context。受保护页面 CSR，SDK 在首次业务数据加载前静默恢复内存 token。菜单、标签切换和操作复用当前展示。
- 个人管理页可编辑姓名和部门，继续提供既有邮箱、密码及行情偏好操作。资料保存后更新当前浏览器的账号展示。完整重载仍按登录时签名的资料声明显示，重新登录后获取最新声明。

## 原页面登录与操作预检

- 根 layout 挂载唯一 `LoginDialog`。匿名点击受保护页面、原生表单或已登记 API 操作时，前端先读取共享会话快照。需要登录则打开站内提示框，权限不足则通过全局消息提示。
- 提示框按钮同步打开登录弹窗，Auth0 SPA SDK 完成授权码 + PKCE，再用 Bearer 请求 `/auth/permissions` 校验登录。成功更新共享展示并通过 `goto` 继续原页面，保留输入。
- 弹窗被拦截、取消、失败或超时时保留原页和输入，可重新打开。SDK 管理 state、PKCE 和 popup origin 校验。受保护直达静默恢复失败时通过 SDK redirect，不等待尚未挂载的提示框。
- SDK 收到 Auth0 拒绝响应并关闭授权窗口后，原页面模态框持续显示返回的错误码和错误消息，并提供重新登录。失败不结束待登录操作。直达登录回调在当前内存中保留同样的错误信息及安全返回位置，不自动重试。错误信息按纯文本展示，不写入 URL、日志或持久存储。刷新后没有原始信息时显示通用重试状态。
- 操作预检复用 Gateway 生成的路径、方法和 named action 权限契约，不替代服务端实时授权。未发送的请求可在登录后继续。后台返回 401 时读取最多重试一次，写入不自动重发。后台 403 就地提示并更新权限快照。
- access token 只在 SDK 内存缓存。本站不使用登录 Cookie。刷新后由 Auth0 SSO 静默恢复，失败重新授权。退出由 SDK 清除内存并退出 Auth0。

## 我的、权限与通知

`/management` 和旧 `/profile` 重定向至 `/management/me`，不再提供管理总览或独立个人页面。管理导航上方为“我的、权限、通知”，面向登录用户。分割线下“消息投递、角色权限、资金日报”仅 admin 可见。后台服务与资金日报上传同时在 Gateway 校验 admin，普通业务 scope 不能替代角色。

`/management/permissions` 读取当前账号角色和有效权限。资料与显示偏好保留在“我的”。`/management/notifications` 通过 `/api/notifications/settings` 管理独立联系邮箱、Telegram Chat ID 和三类通知的渠道选择。`/api/notifications/push` 注册或移除本人设备。

Workflow 通知只向管理员开放。交易/融资订阅需相应业务读取权限。服务端使用 locals.user 的 Auth0 ID，不接收客户端指定用户。

前端复用 permissionVisibility、Button permission 和路由契约控制入口可见性。门户受保护卡片只按共享客户端授权快照显示。首屏快照未确定前不显示。WorkbenchShell 自动过滤无权页面。

原生链接、表单及 data-permission 控件由 auth-controls 同步隐藏，移除焦点并保留请求前置检查。新写控件必须声明权限。服务端准入仍由 Gateway 负责。

PWA manifest 与 service-worker 为公开静态资产。Service Worker 只缓存离线页和图标，不缓存登录态页面/API。Push 在后台展示，设置 `requireInteraction: true` 请求保留至用户点击或关闭，并将点击限定为本站地址。系统通知样式仍由浏览器与操作系统决定。

macOS 需将 Chrome 通知设为持续提醒才能让屏幕横幅持续显示。当前设备启用必须由用户点击授权。不在页面加载时请求通知权限。

## 通知管理标签页

`/management/messenger` 的消息投递和测试消息复用共享 header 标签栏，以 `?tab=delivery` / `?tab=test` 深链选择。默认与未知值回到消息投递。复制链接、刷新及浏览器历史恢复同一标签页。`NotificationManagement` 只负责当前页内容，标签导航由管理 layout 维护。管理员权限和发送动作校验保持原有边界。

---
name: prototype-lab-publish
description: 发布静态网站到 AiWork prototype-lab（https://aiwork.dfcfs.cn/prototype-lab）的自动化流程。当用户要求把 HTML 站点、网页原型、静态网站发布上线到 prototype-lab、获取分享链接、自动化发布/更新网站、切换或回滚已发布版本、下线站点，或研究 prototype-lab 发布接口/实现机制时使用。包含后端接口清单、认证方式与可执行发布脚本。
metadata:
  displayName: "prototype-lab 网站发布"
  summary: "将静态网站打包发布到 prototype-lab 并管理版本"
---

# prototype-lab 静态网站发布

## 角色与目标

你是 AiWork 的 prototype-lab 发布助手。用户生成静态网站（HTML 站点/网页原型）后，可以通过本技能将其**发布上线**到 `https://aiwork.dfcfs.cn/prototype-lab/{appKey}`，获得可分享的 liveUrl，并支持版本切换、回滚与下线。

## 触发条件

- 用户要求「发布网站 / 发布到 prototype-lab / 上线分享 / 获取分享链接」
- 用户要求「自动化发布网站 / 写发布脚本 / 批量发布」
- 用户要求「更新已发布版本 / 切换版本 / 回滚 / 下线站点」
- 用户询问 prototype-lab 发布接口、实现机制、如何抓包/复现发布流程

## 核心结论（背景知识）

AiWork 有**两条分享链路**，本技能只处理 prototype-lab 静态站点发布：

| 链路 | 接口 | 产物 URL |
|---|---|---|
| 任务/对话分享 | `/share/create` + `/share/publish` | `/share/{shareCode}` |
| **prototype-lab 站点发布（本技能）** | **`/hosting/apps` 系列** | **`https://aiwork.dfcfs.cn/prototype-lab/{appKey}`** |

前端「发布并分享」按钮 → `POST /hosting/apps` 创建应用 → 打包 zip → `POST /hosting/apps/{appKey}/publish` 上传 → 返回 `{ liveUrl, releaseVersion }`。liveUrl 即 `https://aiwork.dfcfs.cn/prototype-lab/{appKey}`，appKey 形如 `ses-xxx--yyy`。

## 接口总览

- **本地代理 Base URL（默认）**：`http://127.0.0.1:8787/api/v1`，由 aiwork-adapter 注入共享登录 token。
- **远端 Base URL（/hosting 等业务前缀）**：`https://aiwork.dfcfs.cn/dong-cowork-backend-api/api/v1`
- 普通接口 base：`https://aiwork.dfcfs.cn/dong-cowork-backend/api/v1`（本技能基本不用）
- **远端认证 Header**：`X-DCB-Session-Token: <token>`（代理自动注入）；`X-DCB-Device-Info: {"version":"…"}`（可选）
- 远端 401 的 `X-DCB-Refresh-Token` 头用于续期；本地代理负责鉴权恢复，不将凭证响应头交给脚本。

核心接口：

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/hosting/apps` | 创建应用，返回 `{ appKey }` |
| POST | `/hosting/apps/{appKey}/publish` | multipart 上传 zip 发布，返回 `{ liveUrl, releaseVersion }` |
| GET | `/hosting/apps/{appKey}/versions` | 版本列表 |
| POST | `/hosting/apps/{appKey}/versions/current` | 切换/回滚版本 |
| POST | `/hosting/apps/{appKey}/offline` | 下线站点 |
| GET | `/hosting/apps/{appKey}/download?company=security` | 下载已发布站点（回读验证） |
| GET | `/entry/getOutLinkedUrl?url=…` | 外链 URL 解析 |

完整字段、请求/响应示例见 `references/api.md`。

## 发布流程

1. **确认产物与入口**：确定要发布的网站目录（含构建产物）和入口 HTML 文件（如 `index.html`）。构建产物资源引用须为相对路径。
2. **确认本地代理可用**：默认由 aiwork-adapter 注入共享 Token，无需手动获取；显式直连远端时见下文「认证与安全边界」。
3. **创建应用**（首次发布时）：`POST /hosting/apps`，body `{ "name": "<sessionId>", "slug": "<slug>", "frameworkType": "plain_html" }`，slug 为 name 小写并将 `_` 换 `-`。拿到 `appKey`。若已有 appKey（本地 deploymentInfo 记录过）可跳过。
4. **打包 zip**：把网站目录全部文件打成 zip（zip 根目录含入口 HTML，与站点内相对路径一致）。
5. **发布**：`POST /hosting/apps/{appKey}/publish`，multipart 字段 `artifact`（zip 文件，建议文件名 `artifact.zip`）+ `entryFile`（入口文件名）。返回 `{ liveUrl, releaseVersion }`。
6. **返回结果**：把 `liveUrl`（即 prototype-lab 分享链接）展示给用户；如需可同时保存 `appKey`、`releaseVersion` 到本地部署信息（项目 metadata.deploymentInfo）。

**更新已发布站点**：同一 appKey 直接再次 publish，获得新 releaseVersion；需要切换回旧版本时调 `versions/current`。

## 认证与安全边界（HARD RULE）

- 默认通过本机 aiwork-adapter 调用，不需要手动提供 token。本地代理模式忽略环境变量或参数中的 Token，脚本不自动跟随重定向。适配器与 AiWork 共用加密登录态，逐次读取，不维护独立 token 或定时续期。
- 仅 401 时重读共享登录态；若 AiWork 已更新，原请求最多重试一次。AiWork 未运行且 401 带刷新头时，代理合并并发刷新、写回同一加密文件后重试一次。AiWork 运行时刷新由 AiWork 负责，代理不会抢先刷新；共享状态尚未更新时保留 401。
- 代理不可用时先启动已安装的适配器（`aiwork-adapter start`），不自动改为读取本地凭证。显式直连远端才需要以下 token 获取方式。
- **禁止代读 auth-secure.json 或其他本地凭证文件**（含仅打印结构、拼接命令读取等变体），该行为会被安全策略拦截且不合法。
- token 获取方式（由用户自行完成，或通过已获授权的通道）：
  1. 应用运行中通过主进程 IPC `AUTH_GET_TOKEN` 获取（需开发插件/扩展或用户提供）；
  2. 用户主动从应用内复制 token 提供给脚本（环境变量/参数传入）；
  3. 用户自行编写 Electron 脚本用 safeStorage 解密（本机 Keychain 授权，属用户本机操作）。
- **不得在输出、文件、记忆或日志中明文保存 token**。
- 发布、切换版本、下线等**写操作**执行前须向用户说明并取得确认；创建/发布类操作默认先 dry-run 或与用户核对参数。

## 使用内置脚本

`scripts/publish.py` 提供一键发布（Python 3 标准库，无第三方依赖）。默认通过本地 aiwork-adapter；上传请求默认限 10 MiB，可调整适配器 `AIWORK_MAX_BODY_BYTES`：

```bash
# 默认调用本地代理，无需传 token
python3 scripts/publish.py --dir ./dist --entry index.html

# 已有 appKey 时更新发布
python3 scripts/publish.py --dir ./dist --entry index.html --app-key ses-xxx--yyy

# 其他：--name/--slug 自定义应用名；--base 自定义代理地址；--dry-run 无需 token，只打包不上传

# 显式直连远端（token 通过环境变量传入）
PROTOTYPE_LAB_TOKEN=<token> python3 scripts/publish.py --dir ./dist --entry index.html \
  --base https://aiwork.dfcfs.cn/dong-cowork-backend-api/api/v1
```

脚本行为：无 appKey 时先创建应用 → 内存打包 zip → 上传发布 → 打印 `liveUrl` 与 `releaseVersion`。详见脚本内注释。

## 合规与安全提示

- prototype-lab 为内部站点，发布内容应符合公司信息安全要求，不含敏感业务数据。
- 涉及证券业务内容发布时，遵守投资者适当性、营销宣传等合规要求（不承诺收益、标注风险提示等）。
- 脚本中的 token 只存在于进程环境，脚本本身不落盘凭证。
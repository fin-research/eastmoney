# prototype-lab 发布接口参考（完整明细）

> 基于 AiWork 客户端源码（app.asar + renderer bundle）逆向整理，2026-10-28 核对。
> 来源文件：`packages/renderer/dist/assets/deployment-offline-*.js`、`ChatView-*.js`、`index-*.js`、`out/main/index-*.js`。

## 1. Base URL 与路由规则

生产环境（sec / prod）API 域名：`https://aiwork.dfcfs.cn`

客户端按路径前缀选择 backend：

| 前缀 | backend | version | 完整 base |
|---|---|---|---|
| 普通接口 | `dong-cowork-backend` | `api/v1` | `https://aiwork.dfcfs.cn/dong-cowork-backend/api/v1` |
| `/r` `/skill` `/hosting` `/experts` `/assistants` `/dong-open-platform` `/share` `/cloud-drive` | `dong-cowork-backend-api` | `api/v1` | `https://aiwork.dfcfs.cn/dong-cowork-backend-api/api/v1` |

本技能所有接口均属 `/hosting`、`/entry` 前缀，**base = `https://aiwork.dfcfs.cn/dong-cowork-backend-api/api/v1`**。

本机默认通过 `http://127.0.0.1:8787/api/v1` 调用以下接口，由 aiwork-adapter 注入共享登录 Token。
以下远端路径和信封结构保持不变；代理不向调用方返回 session/refresh 凭证头。

## 2. 通用请求头

```
X-DCB-Session-Token: <token>            # 认证，必填
X-DCB-Device-Info: {"version":"1.18.18"} # 客户端版本信息（可选）
```

- 401 响应会带 `X-DCB-Refresh-Token` 响应头，用于续期 token。
- 响应体为信封结构：`{ "data": <业务数据> }` 或 `{ "error": <code>, ... }`。

## 3. 接口明细

### 3.1 创建应用

```
POST /hosting/apps
Content-Type: application/json

Body:
{
  "name": "ses-xxx（会话 ID）",
  "slug": "ses-xxx（小写、下划线转连字符）",
  "frameworkType": "plain_html"
}

Response 200:
{ "data": { "appKey": "ses-xxx--yyy", "name": "...", "slug": "...", ... } }
```

- `appKey` 由后端生成，形如 `ses-<base36>--<suffix>`，即 prototype-lab URL 中的路径段。
- `slug` = `name.split("_").join("-").toLowerCase()`（客户端 `mi()` 函数逻辑）。

### 3.2 发布（上传 zip）— 核心

```
POST /hosting/apps/{appKey}/publish
Content-Type: multipart/form-data

FormData:
  artifact   = <zip 二进制>，建议 filename "artifact.zip"
  entryFile  = <入口文件名>，如 "index.html"

Response 200:
{ "data": { "liveUrl": "https://aiwork.dfcfs.cn/prototype-lab/{appKey}", "releaseVersion": 3 } }
```

- zip 内容为网站**全部文件**，zip 根目录即站点根目录（含入口 HTML 与相对路径资源）。
- 每次发布生成新的 `releaseVersion`（递增数字）。
- 客户端 60s 超时；zip 大小上限未在客户端限制（50MB 为下载侧限制，上传侧以服务端为准）。

### 3.3 版本列表

```
GET /hosting/apps/{appKey}/versions

Response 200:
{ "data": [ { "releaseVersion": 1, "entryFile": "index.html", "createdAt": "...", ... }, ... ] }
```

### 3.4 切换 / 回滚版本

```
POST /hosting/apps/{appKey}/versions/current
Content-Type: application/json

Body: { "releaseVersion": 2 }

Response 200:
{ "data": { "releaseVersion": 2, ... } }
```

### 3.5 下线站点

```
POST /hosting/apps/{appKey}/offline
Content-Type: application/json

Body: { "releaseVersion": "3" }   # 注意：字符串

Response 200:
{ "data": { ... } }
```

下线后 liveUrl 失效；可再次 publish 恢复。

### 3.6 下载已发布站点（回读验证）

```
GET /hosting/apps/{appKey}/download?company=security

Response 200:
{ "data": { "filename": "site.zip", "presigned_url": "https://<对象存储预签名 URL>" } }
```

- 客户端（prototype_lab 工具 / 主进程 `downloadPrototypeLab`）解析 `presigned_url` 后下载 zip 并解压。
- `company` 取值：`em`（东财）/ `security`（证券），生产 sec 环境为 `security`。

### 3.7 外链 URL 解析

```
GET /entry/getOutLinkedUrl?url=<url>

Response 200:
{ "data": "<解析后的可外链 URL>" }
```

## 4. 响应信封与错误

- 成功：`{ "data": ... }`
- 失败：`{ "error": "<code>", "errorData": { "code", "message", "status?", "traceId?" } }`，HTTP 状态码非 2xx。
- 常见错误码：`401`（token 失效 → 用 `X-DCB-Refresh-Token` 续期）、`404`（appKey 不存在）、`4xx/5xx`（服务端业务错误）。

## 5. 与 task-share 链路的区别（避免混淆）

| 维度 | prototype-lab（本技能） | task-share |
|---|---|---|
| 接口 | `/hosting/apps/*` | `/share/create` `/share/publish` `/share/messages` |
| 上传 | multipart zip 直传 | 先云盘上传（`/cloud-drive/file/upload`）再发布 |
| 产物 | 静态网站（可部署、可切版本） | 会话+产物快照（只读分享） |
| URL | `https://aiwork.dfcfs.cn/prototype-lab/{appKey}` | `https://aiwork.dfcfs.cn/share/{shareCode}` |

用户要「发布网站/原型」走本技能；要「分享对话记录」走 task-share（不属本技能范围）。
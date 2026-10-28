# Cloudflare 凭据

项目组根目录未跟踪的 `.env` 保存 `CLOUDFLARE_API_TOKEN`。不要复制到仓库、命令参数或日志。目标项目的验证与发布步骤仍以其 `AGENTS.md` 为准。

在目标仓库使用已登录的 Wrangler。需要项目组 API Token 时，使用 Wrangler 或 Node 自带的环境文件参数：

```bash
pnpm exec wrangler whoami --env-file ../.env
```

需要 API Token 的 Node 脚本使用 `node --env-file=../.env` 启动。Token 权限不足时报告缺失权限。

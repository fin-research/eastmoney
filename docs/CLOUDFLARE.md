# Cloudflare 凭据

根目录未跟踪的 `.env` 保存 `CLOUDFLARE_API_TOKEN`。不要写入仓库、命令参数或日志。

默认使用已登录的 Wrangler。需要项目组 token 时加载 `.env`：

```bash
pnpm exec wrangler whoami --env-file ../.env
```

Node 脚本用 `node --env-file=../.env` 启动。token 权限不足时，报告缺少的权限。

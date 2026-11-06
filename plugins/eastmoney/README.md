# eastmoney 插件

本仓库的全部 skill 只在这里维护（`plugins/eastmoney/skills/`），Claude Code、OpenCode、AiWork 共用同一份。

- MCP：`eastmoney`（https://eastmoney.hasbai.xyz/mcp，OAuth）
- 技能：market-commentary（含今日聚焦）、secondary-pool-weekly（含增量上传台账）、research-commentary、interbank-ledger、bond-investor、vertical-visual-report、humanizer-zh、install-mcp、prototype-lab-publish
- 依赖：Node.js 20+（报告脚本）；interbank-ledger 另需 macOS、Playwright 和办公网络，凭据见其 SKILL.md；bond-investor 的本机 OCR 需 macOS

## Claude Code

```
/plugin marketplace add fin-research/eastmoney
/plugin install eastmoney@fin-research
```

首次使用运行 `/mcp` 授权 eastmoney。

## OpenCode / AiWork

OpenCode 1.18.18（AiWork-sec 1.6.0 内置）支持 `skills.paths`，递归扫描其中的 `**/SKILL.md`。在 `opencode.json`（AiWork 为 `~/.aiwork-sec/.config/opencode/opencode.json`）加入本插件的 skills 目录即可：

```json
{
  "skills": {
    "paths": ["~/src/eastmoney/plugins/eastmoney/skills"]
  }
}
```

`~/src/eastmoney` 换成本机 checkout 路径。该路径不存在时 opencode 只记日志警告、不加载任何 skill；曾指向旧根目录 `skills/` 的配置须改成此路径。路径指向本仓库 checkout，`git pull` 后立即生效，无需复制。MCP 接入见 [install-mcp](skills/install-mcp/SKILL.md)。skill 里的工具只写短名，完整名随宿主：Claude Code 为 `mcp__plugin_eastmoney_eastmoney__<短名>`，OpenCode / AiWork 为 `eastmoney_<短名>`。

OpenCode 会同时扫描 全局 `~/.claude/skills`、`~/.agents/skills`、`~/.config/opencode/skills`，以及项目内向上查找到的 `.claude/skills`、`.agents/skills`、`.opencode/skills`。不要在这些目录再放本插件的同名副本：重复的 skill 名只记 `duplicate skill name` 警告，实际加载哪一份不确定。

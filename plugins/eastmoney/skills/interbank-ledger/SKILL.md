---
name: interbank-ledger
description: 处理交易管理「拆借台账」流程：用户给出成交 ZIP（信用拆借成交查询 Excel 加每笔成交单 PDF）后，脚本解压、按成交编号关联并重命名、归档到成交日期目录，再登录资金系统（http://10.6.88.192:7000/）导入台账、上传 PDF 附件并保存还款草稿；用户在资金系统提交流程后，用 Playwright 复用登录 cookie 逐笔截图（划拨申请、审批流程）归档到当天目录。用户说“拆借台账”“处理今天的拆借压缩包”“拆借成交单归档并上传资金系统”“拆借流程截图”“把拆借 zip 导进资金系统”时使用。不提交流程，不用于正回购、债券台账或二级池周报。
---

# 拆借台账

脚本全程自动，验证码先用 Apple Vision 识别，没把握才由模型读图。只依赖 macOS、Node.js 20+、Playwright、办公网络可达资金系统。业务规则与 Dashboard `/trading-research/interbank-ledger` 一致，见 [规则](references/business-rules.md)。

## 前置

- 凭据：`CAMEL_USERNAME`、`CAMEL_PASSWORD` 来自环境变量，或项目根未跟踪的 `.env`（也可用 `CAMEL_ENV_FILE` 指定）。不要打印或回显。
- 归档根目录：默认 `~/Library/CloudStorage/OneDrive-个人/东方财富/交易/拆借`，其下按成交日期建 `YYYY-MM-DD`。用 `--root` 或 `INTERBANK_ARCHIVE_ROOT` 覆盖。
- Playwright：本机已有则自动发现；否则 `npm i --prefix ~/.cache/eastmoney-interbank playwright && npx --prefix ~/.cache/eastmoney-interbank playwright install chromium`，或用 `PLAYWRIGHT_MODULE` 指向已有安装。
- 首次运行会用 `swiftc` 编译 `captcha-ocr.swift`、`pdf-text.swift` 到系统临时目录。

## 步骤

1. 确认用户给的 ZIP 路径（常见于 `~/Downloads`，文件名如 `IBO20261105300116.zip`）。先预检：

   ```sh
   node <本skill目录>/scripts/run.mjs import <zip> --dry-run
   ```

   输出成交日、成交编号和归档文件名。失败（多个 Excel、PDF 与 Excel 编号对不上、多个成交日、方向不是拆入）时如实说明，不改数据重试。

2. 归档、导入并保存还款草稿，在后台运行并关注 stderr：

   ```sh
   node <本skill目录>/scripts/run.mjs import <zip>
   ```

   脚本依次：写入 `<root>/<成交日>/`（已有相同文件跳过，内容不同则整体拒绝）→ API 登录 → 查台账 → 导入缺失成交（解析、额度检查、保存）→ 逐笔上传 PDF 附件并保存还款草稿并回读核对。已存在的台账和草稿不重复创建，可安全重跑。stdout 为 JSON 汇总：`imported`、`drafts[].status`（`saved` 新建，`exists` 已有）。

3. **验证码**：stderr 出现 `NEED_CAPTCHA <图片路径> -> ... <答案文件>` 时，用 Read 读该图片，把 4 位字符（大小写敏感）写入答案文件，脚本自动继续。没有该行说明 Apple OCR 已自动完成，无需读图。

4. 告诉用户草稿已保存、需在资金系统同业拆入页提交流程。**脚本和模型都不提交流程**。等用户确认已提交。

5. 提交后截图并归档：

   ```sh
   node <本skill目录>/scripts/run.mjs shots <YYYY-MM-DD>
   ```

   生成 `<root>/<成交日>/流程截图/`：`同业拆入台账.png`、`我的提交.png`，以及每笔的 `<成交编号> 划拨申请.png`、`<成交编号> 审批流程.png`。汇总里 `missing` 非空（退出码 2）表示有笔没截到，`notSubmitted` 列出仍是草稿的成交；如实告诉用户并在其提交后重跑，重跑覆盖同名截图。

6. 汇报实际结果：归档目录与文件数、导入笔数、草稿状态、截图张数和缺失项、验证码来源。

## 边界

- 只处理「拆入」成交。拆出、多日 Excel 和 PDF 无法关联的批次一律停止。
- 台账或草稿与本批不一致、导入或草稿结果无法确认时停止，不盲目重传。不得为过关修改归档文件或绕过校验。
- 脚本不撤回、不废弃、不提交、不修改已有台账。
- 验证码最多提交 3 次，仍失败即停止，不反复尝试登录。

## 自测

`node <本skill目录>/scripts/selftest.mjs` 离线运行，不联网、不登录。

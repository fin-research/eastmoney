# 公开授信扫描 PDF 的本地文字层

此流程保留原始扫描件，在副本上叠加可搜索的中文文字层。已有正常文字层的年报、半年报不用 OCR。Apple Vision 在密集财务表格中仍可能误认小数点、逗号和相邻列。这些页的金额必须回看原始页面，不能只凭提取文本入库为确定数值。

需要 macOS、Swift/Vision、Poppler `pdftoppm`、Ghostscript、Python `pikepdf` 和 `reportlab`，以及支持中文的 TrueType 字体。示例使用 `NotoSansSC-VF.ttf`。不要覆盖原始 PDF。压缩和 OCR 均在单独目录运行。

```sh
swiftc scripts/credit-pdf-ocr/vision-boxes.swift -o /tmp/vision-boxes

# 审计报告通常只有第 6–20 页为扫描表格，先压缩副本以满足 AI Search 的 4 MB 限额。
gs -q -sDEVICE=pdfwrite -dCompatibilityLevel=1.7 -dNOPAUSE -dBATCH -dSAFER \
  -dPDFSETTINGS=/screen -dDetectDuplicateImages=true -dCompressFonts=true \
  -dDownsampleColorImages=true -dColorImageResolution=130 \
  -dDownsampleGrayImages=true -dGrayImageResolution=130 \
  -dDownsampleMonoImages=false -sOutputFile=/tmp/audit-base.pdf /path/to/original-audit.pdf

uv run --with pikepdf --with reportlab python scripts/credit-pdf-ocr/overlay_vision.py \
  /path/to/original-audit.pdf /tmp/audit-base.pdf /path/to/output-audit.pdf \
  --pages 6,7,8,9,10,11,12,13,14,15,16,17,18,19,20 \
  --font /path/to/NotoSansSC-VF.ttf --vision-binary /tmp/vision-boxes

# 全扫描的独立财务报表，把同一原件同时作为 original 和 base，--pages 列出所有页。
```

逐份用 `stat` 核对文件小于 `4,000,000` 字节，`pdfinfo` 核对页数。用 `pdftotext -layout` 检查每个扫描页的中文表项与关键数值。用 `pdftoppm` 对比原件与修复件同页图像。审计报告的末页净资产收益率表要核对指标列、行名、年度和值。处理过的带数字签名 PDF 是检索副本，签名效力以保留的原件为准。

上传 `eastmoney/credit/public/` 时先留存线上旧版，上传后重新下载并比对 SHA-256。R2 是外部数据源，替换同名文件后还要触发 AI Search `credit` 的同步作业。只触发单 Item `INDEX` 可能继续使用旧文件清单。最后核对 Item `file_size`、最新分块文本与不含答案数字的实际检索问题，不能只看 `completed` 状态。

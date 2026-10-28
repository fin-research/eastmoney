"""查询 Cloudflare R2（article 桶）中本周的机构研报。

默认查询当前自然周（周一至周日，Asia/Shanghai）发布的对象，对象键格式为
yyyy-mm-dd/标题.md。通过 R2 的 S3 兼容端点读取，使用 boto3 SDK。

凭证从项目根目录 .env 读取（不会打印或提交）：
- R2_ACCOUNT_ID：Cloudflare 账号 ID（端点 https://{account_id}.r2.cloudflarestorage.com）
- R2_ACCESS_KEY_ID：R2 API Token 的 Access Key ID
- R2_SECRET_ACCESS_KEY：R2 API Token 的 Secret Access Key
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from email.header import decode_header
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import boto3
from botocore.exceptions import ClientError
from dotenv import load_dotenv


BUCKET = "article"
S3_REGION = "auto"
SHANGHAI = ZoneInfo("Asia/Shanghai")


def current_week_dates(now: datetime | None = None) -> list[datetime.date]:
    """Return the Monday-to-Sunday dates containing now in Shanghai time."""
    local_now = (now or datetime.now(SHANGHAI)).astimezone(SHANGHAI)
    monday = (local_now - timedelta(days=local_now.weekday())).date()
    return [monday + timedelta(days=offset) for offset in range(7)]


def load_s3_config() -> dict[str, str]:
    """Read R2 S3 credentials from the project .env file."""
    load_dotenv(Path(__file__).with_name(".env"))
    names = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY")
    values = {name: os.getenv(name, "").strip() for name in names}
    missing = [name for name, value in values.items() if not value]
    if missing:
        raise RuntimeError(f"未配置 {'、'.join(missing)}，请在项目根目录 .env 中设置。")
    return values


def s3_client(config: dict[str, str]):
    """Build an R2 S3-compatible client from the given config."""
    return boto3.client(
        "s3",
        endpoint_url=f"https://{config['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=config["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=config["R2_SECRET_ACCESS_KEY"],
        region_name=S3_REGION,
    )


def list_object_keys(client, prefix: str, limit: int = 1000) -> list[str]:
    """List object keys under prefix via list_objects_v2 pagination."""
    keys: list[str] = []
    continuation_token: str | None = None
    while True:
        params: dict[str, Any] = {"Bucket": BUCKET, "Prefix": prefix, "MaxKeys": 1000}
        if continuation_token:
            params["ContinuationToken"] = continuation_token
        response = client.list_objects_v2(**params)
        keys.extend(item["Key"] for item in response.get("Contents", []))
        if not response.get("IsTruncated") or len(keys) >= limit:
            break
        continuation_token = response.get("NextContinuationToken")
    return keys[:limit]


def fetch_object(client, key: str) -> tuple[str, dict[str, str]]:
    """Fetch one R2 object body and its custom metadata via S3."""
    response = client.get_object(Bucket=BUCKET, Key=key)
    try:
        content = response["Body"].read().decode("utf-8")
    finally:
        response["Body"].close()
    return content, response.get("Metadata") or {}


def parse_object_key(key: str) -> tuple[str, str] | None:
    """Parse yyyy-mm-dd/标题.md into (date, title)."""
    parts = key.split("/", 1)
    if len(parts) != 2 or not parts[1].lower().endswith(".md"):
        return None
    date_part, filename = parts
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_part):
        return None
    return date_part, filename[:-3]


def decode_metadata_value(value: str) -> str:
    """Decode RFC 2047 encoded-words used by R2 S3 for non-ASCII metadata."""
    if not value or "=?" not in value:
        return value
    parts: list[str] = []
    for chunk, encoding in decode_header(value):
        if isinstance(chunk, bytes):
            parts.append(chunk.decode(encoding or "utf-8", errors="replace"))
        else:
            parts.append(chunk)
    return "".join(parts)


def build_article(
    key: str, content: str, metadata: dict[str, str]
) -> dict[str, Any]:
    parsed = parse_object_key(key)
    return {
        "title": parsed[1] if parsed else key,
        "date": parsed[0] if parsed else "",
        "published_at": metadata.get("published_at", ""),
        "author": decode_metadata_value(metadata.get("author", "")),
        "summary": decode_metadata_value(metadata.get("summary", "")),
        "importance": metadata.get("importance", ""),
        "keywords": decode_metadata_value(metadata.get("keywords", "")),
        "content": content,
    }


def fetch_week_articles(
    client, dates: list[datetime.date], limit: int
) -> list[dict[str, Any]]:
    """Fetch this week's article markdown bodies from the R2 bucket."""
    articles: list[dict[str, Any]] = []
    for day in dates:
        prefix = f"{day.isoformat()}/"
        for key in list_object_keys(client, prefix):
            content, metadata = fetch_object(client, key)
            articles.append(build_article(key, content, metadata))
            if len(articles) >= limit:
                return articles
    return articles


def display_articles(articles: list[dict[str, Any]]) -> None:
    for index, article in enumerate(articles, start=1):
        title = article.get("title") or "（无标题）"
        date_part = article.get("date") or ""
        author = article.get("author") or ""
        suffix = f" | {author}" if author else ""
        summary = article.get("summary") or ""
        print(f"{index}. {date_part}{suffix}\n   {title}")
        if summary:
            print(f"   摘要：{summary}")


def parse_args() -> argparse.Namespace:
    week = current_week_dates()
    default_start = week[0].isoformat()
    default_end = week[-1].isoformat()
    parser = argparse.ArgumentParser(
        description="从 Cloudflare R2（article 桶）查询本周机构研报"
    )
    parser.add_argument(
        "--start-date", default=default_start,
        help=f"起始日期 YYYY-MM-DD，默认：{default_start}",
    )
    parser.add_argument(
        "--end-date", default=default_end,
        help=f"结束日期 YYYY-MM-DD，默认：{default_end}",
    )
    parser.add_argument("--limit", type=int, default=200, help="单次返回数量，默认 200")
    parser.add_argument("--json", action="store_true", help="输出文章列表 JSON（含正文）")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.limit < 1:
        print("limit 必须大于 0。", file=sys.stderr)
        return 2

    try:
        config = load_s3_config()
    except RuntimeError as exc:
        print(f"{exc}", file=sys.stderr)
        return 2

    try:
        start_date = datetime.strptime(args.start_date, "%Y-%m-%d").date()
        end_date = datetime.strptime(args.end_date, "%Y-%m-%d").date()
    except ValueError:
        print("start-date/end-date 必须为 YYYY-MM-DD 格式。", file=sys.stderr)
        return 2
    if end_date < start_date:
        print("end-date 不能早于 start-date。", file=sys.stderr)
        return 2
    dates = [
        start_date + timedelta(days=offset)
        for offset in range((end_date - start_date).days + 1)
    ]

    try:
        articles = fetch_week_articles(s3_client(config), dates, args.limit)
    except ClientError as exc:
        status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode", "")
        code = exc.response.get("Error", {}).get("Code", "")
        hint = ""
        if status in (401, 403):
            hint = "；请检查 R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY 是否具有该桶读权限"
        print(f"查询失败：S3 {status} {code}{hint}", file=sys.stderr)
        return 1
    except RuntimeError as exc:
        print(f"查询失败：{exc}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(articles, ensure_ascii=False, indent=2))
        return 0

    print(f"研报查询区间：{args.start_date} 至 {args.end_date}")
    print(f"共返回 {len(articles)} 篇")
    display_articles(articles)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

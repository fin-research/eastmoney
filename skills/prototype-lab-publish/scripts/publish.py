#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
prototype-lab 静态网站自动化发布脚本（AiWork 内部工具）。

用法：
  python3 publish.py --dir ./dist --entry index.html
  python3 publish.py --dir ./dist --entry index.html --app-key ses-xxx--yyy
  python3 publish.py --dir ./dist --entry index.html --dry-run

参数：
  --dir       网站目录（构建产物，zip 根目录即站点根目录）
  --entry     入口 HTML 文件名，如 index.html
  --app-key   已有应用 key（更新发布时传；首次发布可省略，自动创建）
  --name      创建应用时的 name（默认 = 目录名）
  --slug      创建应用时的 slug（默认 = name 小写、下划线转连字符）
  --base      API base（默认 http://127.0.0.1:8787/api/v1，本地适配器）
  --token     X-DCB-Session-Token（也可用环境变量 PROTOTYPE_LAB_TOKEN 传入，优先环境变量）
  --dry-run   只打包并打印将调用的请求，不上传

安全说明：
  - 默认由本地适配器共用 AiWork 登录态并注入 token；脚本不读取凭证文件、不刷新 token。
  - 直连远端时可用环境变量/命令行参数传 token，不落盘、不打印。
  - 写操作（创建应用、发布）会真实生效，执行前请确认参数。
"""

import argparse
import io
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile

DEFAULT_BASE = "http://127.0.0.1:8787/api/v1"
DEFAULT_HEADERS = {"X-DCB-Device-Info": json.dumps({"version": "1.0"})}


class ApiError(RuntimeError):
    def __init__(self, status, body):
        super().__init__(f"HTTP {status}: {body[:500]}")
        self.status = status
        self.body = body


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(base, method, path, token, body=None, multipart=None, timeout=60):
    """发请求。body: dict(json) 或 bytes；multipart: [ (field, filename, content_type, bytes) ]"""
    url = base.rstrip("/") + path
    headers = dict(DEFAULT_HEADERS)
    if token:
        headers["X-DCB-Session-Token"] = token

    data = None
    if multipart:
        boundary = "----prototype-lab-" + os.urandom(8).hex()
        buf = io.BytesIO()
        for field, filename, ctype, content in multipart:
            buf.write(f"--{boundary}\r\n".encode())
            buf.write(
                f'Content-Disposition: form-data; name="{field}"'.encode()
                + (f'; filename="{filename}"'.encode() if filename else b"")
                + b"\r\n"
            )
            buf.write(f"Content-Type: {ctype}\r\n\r\n".encode())
            buf.write(content if isinstance(content, bytes) else str(content).encode())
            buf.write(b"\r\n")
        buf.write(f"--{boundary}--\r\n".encode())
        data = buf.getvalue()
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    elif body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        raise ApiError(e.code, e.read().decode("utf-8", "replace")) from e

    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return raw.decode("utf-8", "replace")


def build_zip(site_dir):
    """把目录打成 zip（内存），zip 根目录 = 站点根目录。"""
    buf = io.BytesIO()
    root = os.path.abspath(site_dir)
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            for fn in filenames:
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, root)
                zf.write(full, rel)
    return buf.getvalue()


def main():
    ap = argparse.ArgumentParser(description="publish static site to prototype-lab")
    ap.add_argument("--dir", required=True, help="site directory")
    ap.add_argument("--entry", required=True, help="entry html filename, e.g. index.html")
    ap.add_argument("--app-key", default=None, help="existing app key (update publish)")
    ap.add_argument("--name", default=None, help="app name (default: dir basename)")
    ap.add_argument("--slug", default=None, help="app slug (default: name lowercased, _ -> -)")
    ap.add_argument("--base", default=DEFAULT_BASE, help="api base url")
    ap.add_argument("--token", default=None, help="X-DCB-Session-Token")
    ap.add_argument("--dry-run", action="store_true", help="only package, no upload")
    args = ap.parse_args()

    base_url = urllib.parse.urlsplit(args.base)
    local_proxy = base_url.scheme in ("http", "https") and base_url.hostname in ("127.0.0.1", "::1")
    token = None if local_proxy else (os.environ.get("PROTOTYPE_LAB_TOKEN") or args.token)
    if not token and not local_proxy and not args.dry_run:
        sys.exit("直连远端需要 PROTOTYPE_LAB_TOKEN 或 --token；默认本地适配器无需传 token")

    name = args.name or os.path.basename(os.path.abspath(args.dir))
    slug = args.slug or name.replace("_", "-").lower()

    zip_bytes = build_zip(args.dir)
    print(f"[info] zip {len(zip_bytes)} bytes, entry={args.entry}")

    app_key = args.app_key
    if not app_key:
        if args.dry_run:
            print(f"[dry-run] POST {args.base}/hosting/apps  body={{name, slug, frameworkType}}")
        else:
            resp = request(args.base, "POST", "/hosting/apps", token,
                           body={"name": name, "slug": slug, "frameworkType": "plain_html"})
            app_key = resp["data"]["appKey"]
            print(f"[info] app created: {app_key}")

    if args.dry_run:
        key = app_key or "{app-key}"
        print(f"[dry-run] POST {args.base}/hosting/apps/{key}/publish  (multipart artifact+entryFile)")
        print("[dry-run] 完成，未发送任何请求")
        return

    resp = request(
        args.base, "POST", f"/hosting/apps/{app_key}/publish", token,
        multipart=[
            ("artifact", "artifact.zip", "application/zip", zip_bytes),
            ("entryFile", None, "text/plain", args.entry),
        ],
    )
    data = resp.get("data", {})
    print(f"[ok] liveUrl = {data.get('liveUrl')}")
    print(f"[ok] releaseVersion = {data.get('releaseVersion')}")
    print(f"[info] appKey = {app_key}")


if __name__ == "__main__":
    main()
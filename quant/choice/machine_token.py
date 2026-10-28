"""Auth0 machine credentials for the Gateway; never use a human test account."""

from __future__ import annotations

import os
import time
from urllib.parse import urlsplit

import httpx

TOKEN_URL = "https://auth.hasbai.xyz/oauth/token"
API_AUDIENCE = "https://eastmoney.hasbai.xyz/"
_cache: tuple[str, str, str, float] | None = None


class MachineTokenError(RuntimeError):
    """Safe error without credentials or the token response."""


def service_headers(url: str) -> dict[str, str]:
    """Reuse a short-lived machine JWT only for the fixed production origin."""
    global _cache
    client_id = os.environ.get("AUTH0_MACHINE_CLIENT_ID", "").strip()
    secret = os.environ.get("AUTH0_MACHINE_CLIENT_SECRET", "").strip()
    if bool(client_id) != bool(secret):
        raise MachineTokenError("Auth0 机器凭据必须同时配置 ID 和 Secret")
    if not client_id:
        return {}
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.netloc != "eastmoney.hasbai.xyz":
        raise MachineTokenError("机器令牌只允许发送至生产 data API")
    if _cache and _cache[:2] == (client_id, secret) and _cache[3] > time.monotonic():
        return {"Authorization": "Bearer " + _cache[2]}
    try:
        response = httpx.post(
            TOKEN_URL,
            json={
                "grant_type": "client_credentials",
                "client_id": client_id,
                "client_secret": secret,
                "audience": API_AUDIENCE,
            },
            timeout=15.0,
            follow_redirects=False,
        )
    except httpx.HTTPError as exc:
        raise MachineTokenError("Auth0 机器授权网络请求失败") from exc
    if not response.is_success:
        raise MachineTokenError(f"Auth0 机器授权失败（HTTP {response.status_code}）")
    try:
        payload = response.json()
        token = payload["access_token"]
        lifetime = int(payload["expires_in"])
        if (
            not isinstance(token, str)
            or token.count(".") != 2
            or len(token) > 16384
            or lifetime <= 60
            or payload.get("token_type", "").lower() != "bearer"
        ):
            raise ValueError("invalid token")
    except (ValueError, TypeError, KeyError) as exc:
        raise MachineTokenError("Auth0 机器授权返回无效响应") from exc
    _cache = (client_id, secret, token, time.monotonic() + min(lifetime, 3600) - 60)
    return {"Authorization": "Bearer " + token}


def clear_token() -> None:
    global _cache
    _cache = None

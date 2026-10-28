"""通过统一 data API 调用 Choice 只读查询。"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Any

import httpx
from dotenv import load_dotenv
from choice.machine_token import MachineTokenError, clear_token, service_headers

DEFAULT_DATA_API_BASE_URL = "https://eastmoney.hasbai.xyz/data"
DEFAULT_TIMEOUT_SECONDS = 75.0
NO_DATA_ERROR_CODE = 10000009
INVALID_STOCK_CODE_ERROR = 10003008


@dataclass(frozen=True, slots=True)
class ChoiceResult:
    """data API 的 Choice 表格响应。"""

    error_code: int | None
    error_msg: str | None
    function: str | None = None
    fields: tuple[str, ...] = ()
    rows: tuple[dict[str, Any], ...] = ()


class ChoiceAPIError(RuntimeError):
    """data API Choice 请求或响应不符合契约。"""


def _base_url() -> str:
    load_dotenv()
    return (os.environ.get("DATA_API_BASE_URL") or DEFAULT_DATA_API_BASE_URL).rstrip(
        "/"
    )


def _access_headers(url: str) -> dict[str, str]:
    try:
        return service_headers(url)
    except MachineTokenError as exc:
        raise ChoiceAPIError(str(exc)) from exc


def _upstream_error_code(detail: str, status_code: int) -> int:
    match = re.search(r"\b(100\d{5})\b", detail)
    if match:
        return int(match.group(1))
    normalized = detail.casefold()
    if "invalid stock code" in normalized:
        return INVALID_STOCK_CODE_ERROR
    if "no data" in normalized:
        return NO_DATA_ERROR_CODE
    return status_code


def _error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return f"HTTP {response.status_code}"
    if isinstance(payload, dict) and isinstance(payload.get("detail"), str):
        error = payload.get("error")
        code = error.get("upstreamCode") if isinstance(error, dict) else None
        if isinstance(code, int) and 10000000 <= code <= 10099999:
            return f"{code}: {payload['detail']}"
        return payload["detail"]
    return f"HTTP {response.status_code}"


def _parse_table(payload: object, expected_function: str) -> ChoiceResult:
    if not isinstance(payload, dict):
        raise ChoiceAPIError("data API Choice 响应不是 JSON object")
    function = payload.get("function")
    fields = payload.get("fields")
    rows = payload.get("rows")
    if function != expected_function:
        raise ChoiceAPIError(
            f"data API Choice function 不匹配: expected={expected_function}, actual={function}"
        )
    if not isinstance(fields, list) or not all(
        isinstance(item, str) for item in fields
    ):
        raise ChoiceAPIError("data API Choice fields 不符合契约")
    if not isinstance(rows, list) or not all(isinstance(item, dict) for item in rows):
        raise ChoiceAPIError("data API Choice rows 不符合契约")
    return ChoiceResult(
        error_code=0,
        error_msg="success",
        function=function,
        fields=tuple(fields),
        rows=tuple(rows),
    )


def _get_choice_table(
    path: str,
    expected_function: str,
    params: dict[str, str],
    client: httpx.Client | None = None,
) -> ChoiceResult:
    url = f"{_base_url()}/choice/{path}"
    headers = _access_headers(url)
    try:
        get = client.get if client is not None else httpx.get
        response = get(
            url,
            params=params,
            headers=headers,
            timeout=DEFAULT_TIMEOUT_SECONDS,
            follow_redirects=False,
        )
    except httpx.HTTPError as exc:
        raise ChoiceAPIError(
            f"data API Choice 请求失败: {type(exc).__name__}; path=/choice/{path}"
        ) from exc
    if not response.is_success:
        if response.status_code in {401, 403}:
            clear_token()
            return ChoiceResult(
                error_code=response.status_code,
                error_msg="data API Gateway 身份验证失败，请检查 Auth0 机器凭据",
            )
        detail = _error_detail(response)
        return ChoiceResult(
            error_code=_upstream_error_code(detail, response.status_code),
            error_msg=detail,
        )
    try:
        payload = response.json()
    except ValueError as exc:
        raise ChoiceAPIError("data API Choice 返回无效 JSON") from exc
    return _parse_table(payload, expected_function)


def ctr(report_name: str, indicators: str, options: str) -> ChoiceResult:
    params = {"reportName": report_name}
    if indicators:
        params["indicators"] = indicators
    if options:
        params["options"] = options
    return _get_choice_table("ctr", "CTR", params)


def css(
    codes: str, indicator: str, options: str, *, client: httpx.Client | None = None
) -> ChoiceResult:
    params = {"codes": codes, "indicators": indicator}
    if options:
        params["options"] = options
    return _get_choice_table("css", "CSS", params, client=client)

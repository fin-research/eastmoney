# Choice RPC contract

## Read-only methods

The service exposes six read-only SDK functions:

- `POST /rpc/v1/choice/csd`
- `POST /rpc/v1/choice/css`
- `POST /rpc/v1/choice/ctr`
- `POST /rpc/v1/choice/edb`
- `POST /rpc/v1/choice/datastatistics`
- `POST /rpc/v1/choice/tradedates`

Authentication uses `Authorization: Bearer $CHOICE_RPC_TOKEN`. Login, logout,
activation, callbacks, and arbitrary SDK method names are not RPC methods. The
process performs the former client's one-time `manualactivate` recovery
internally when Choice returns expired `userInfo` code `10001020`.

A successful body uses the table contract below. The Data Worker verifies the
RPC version, parses JSON, and validates the table before exposing its DTO:

```json
{
  "function": "CSD",
  "fields": ["code", "date", "CLOSE"],
  "rows": [{"code": "000001.SH", "date": "2026-08-29", "CLOSE": 3857.9}]
}
```

The response headers contain `X-Choice-Rpc-Version: choice.rpc.v1` and echo the
Worker's `X-Request-Id` on successful and failed parsed requests. The service trims IDs and limits them
to 128 bytes; internal control bytes, spaces and non-ASCII bytes become `_`. Errors before
the HTTP parser returns a complete request have no request ID. Errors use one stable shape:

`tradedates` accepts `{ "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD", "options": "Market=CNSESH,Period=1,Order=1" }` and returns `{"function":"TRADEDATES","fields":["date"],"rows":[{"date":"YYYY-MM-DD"}]}`. Dates come from the SDK's calendar result, not from market quotes.

```json
{
  "error": {
    "code": "CHOICE_UPSTREAM",
    "message": "upstream error without credentials",
    "retryable": true,
    "upstreamCode": 10003001
  }
}
```

[rpc_contract.cpp](../src/rpc_contract.cpp) implements the RPC boundary. [main.cpp](../src/main.cpp) handles HTTP dispatch. [test_rpc.cpp](../tests/test_rpc.cpp) covers regressions. [choice/client.ts](../../data/src/choice/client.ts) consumes the RPC in Data. Update both sides and their tests for changes to version, table shape, or date normalization. Public `/data/choice/*` routing belongs to [Data](../../data/docs/API.md).

Each parsed request emits one `choice_rpc_result` JSON log. It contains only
`function` (one of the six method names or `unknown`), HTTP `status`, nullable
`upstreamCode`, `durationMs` and the sanitized `requestId`. The log excludes request
bodies, options, tokens, quota values and exception text. The log does not change
SDK calls or retries.

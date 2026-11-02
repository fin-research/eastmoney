# Choice RPC contract

## Read-only methods

The service exposes six read-only SDK functions:

- `POST /rpc/v1/choice/csd`
- `POST /rpc/v1/choice/css`
- `POST /rpc/v1/choice/ctr`
- `POST /rpc/v1/choice/edb`
- `POST /rpc/v1/choice/datastatistics`
- `POST /rpc/v1/choice/tradedates`

Authentication uses `Authorization: Bearer $CHOICE_RPC_TOKEN`. `GET /health` needs no token. Login, logout, activation and other SDK methods are not RPC methods. When Choice returns expired `userInfo` code `10001020`, the process runs the one-time `manualactivate` recovery internally.

`tradedates` accepts the following body and returns `{"function":"TRADEDATES","fields":["date"],"rows":[{"date":"YYYY-MM-DD"}]}`. Dates come from the SDK calendar, not from market quotes.

```json
{ "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD", "options": "Market=CNSESH,Period=1,Order=1" }
```

## Response

A successful body uses this table contract. The Data Worker checks the RPC version, parses the JSON and validates the table before it exposes a DTO.

```json
{
  "function": "CSD",
  "fields": ["code", "date", "CLOSE"],
  "rows": [{"code": "000001.SH", "date": "2026-08-29", "CLOSE": 3857.9}]
}
```

Every response carries `X-Choice-Rpc-Version: choice.rpc.v1`. Parsed requests also echo the Worker's `X-Request-Id`. The service trims it to 128 bytes and replaces spaces, control bytes and non-ASCII bytes with `_`.

Errors use one stable shape:

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

Each parsed request writes one `choice_rpc_result` JSON log with `function` (a method name or `unknown`), `status`, nullable `upstreamCode`, `durationMs` and the sanitized `requestId`. The log has no request bodies, options, tokens, quota values or exception text.

## Change rules

[rpc_contract.cpp](../src/rpc_contract.cpp) implements the contract, and [choice/client.ts](../../data/src/choice/client.ts) consumes it in Data. Update both sides and their tests when the version, table shape or date normalization changes. Public `/data/choice/*` routing belongs to [Data](../../data/docs/API.md).

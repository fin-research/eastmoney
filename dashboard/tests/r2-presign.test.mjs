import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'tsx/esm/api';
register();
const { presignR2PutUrl } = await import('../src/lib/server/r2-presign.ts');

test('presigned PUT matches the R2/boto3 signature vector and URL shape', async () => {
  const { url, expiresAt } = await presignR2PutUrl(
    { accessKeyId: 'DUMMYAKID', secretAccessKey: 'DUMMYSECRET' },
    '5cecc63c78acf8f5473f8745f4244448',
    'eastmoney',
    'bond-ledger/imports/123e4567-e89b-12d3-a456-426614174000.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    900,
    new Date('2026-10-30T05:20:02.000Z'),
  );
  assert.equal(expiresAt, '2026-10-30T05:35:02.000Z');
  assert.match(url, /^https:\/\/5cecc63c78acf8f5473f8745f4244448\.r2\.cloudflarestorage\.com\/eastmoney\/bond-ledger\/imports\/123e4567-e89b-12d3-a456-426614174000\.xlsx\?/);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.equal(parsed.searchParams.get('X-Amz-Credential'), 'DUMMYAKID/20261030/auto/s3/aws4_request');
  assert.equal(parsed.searchParams.get('X-Amz-Date'), '20261030T052002Z');
  assert.equal(parsed.searchParams.get('X-Amz-Expires'), '900');
  assert.equal(parsed.searchParams.get('X-Amz-SignedHeaders'), 'content-type;host;if-none-match');
  assert.deepEqual(await presignR2PutUrl(
    { accessKeyId: 'DUMMYAKID', secretAccessKey: 'DUMMYSECRET' },
    '5cecc63c78acf8f5473f8745f4244448', 'eastmoney',
    'bond-ledger/imports/123e4567-e89b-12d3-a456-426614174000.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 900,
    new Date('2026-10-30T05:20:02.000Z'),
  ).then(value => value.requiredHeaders), {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'If-None-Match': '*',
  });
  // Reference signature produced by boto3 generate_presigned_url against the same inputs.
  assert.equal(parsed.searchParams.get('X-Amz-Signature'), 'f85bfd23bc98ee9091071d8e3e357522c1bb44b73f763b43281fd5324aefb7ca');
  // Signature must be the trailing query parameter and expiry is fixed.
  assert.ok(url.endsWith('&X-Amz-Signature=f85bfd23bc98ee9091071d8e3e357522c1bb44b73f763b43281fd5324aefb7ca'));
  assert.equal(new URL(url).searchParams.get('x-amz-content-sha256'), null);
});

test('presigned PUT is deterministic per instant and scopes to the requested key', async () => {
  const credentials = { accessKeyId: 'AKID', secretAccessKey: 'SECRET' };
  const account = 'acct1';
  const first = await presignR2PutUrl(credentials, account, 'eastmoney', 'a/b/c.xlsx', 'application/octet-stream', 60, new Date('2026-01-02T03:04:05.000Z'));
  const second = await presignR2PutUrl(credentials, account, 'eastmoney', 'a/b/c.xlsx', 'application/octet-stream', 60, new Date('2026-01-02T03:04:05.000Z'));
  assert.equal(first.url, second.url);
  assert.equal(first.expiresAt, '2026-01-02T03:05:05.000Z');
  const other = await presignR2PutUrl(credentials, account, 'eastmoney', 'a/b/d.xlsx', 'application/octet-stream', 60, new Date('2026-01-02T03:04:05.000Z'));
  assert.notEqual(first.url, other.url);
  assert.match(new URL(first.url).pathname, /\/eastmoney\/a\/b\/c\.xlsx$/);
});

const { readBondLedgerJson, importBondLedgerUpload } = await import('../src/lib/server/bond-ledger.ts');
test('JSON body limit counts actual streamed bytes despite forged Content-Length', async () => {
  for (const headers of [{}, { 'Content-Length': '1' }]) {
    const request = new Request('https://example.com', { method: 'POST', headers, duplex: 'half',
      body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(20)); c.enqueue(new Uint8Array(20)); c.close(); } }) });
    await assert.rejects(readBondLedgerJson(request, 32), e => e.status === 413);
  }
});
test('direct import rejects null and missing filename with 400 before reading storage', async () => {
  for (const input of [null, {}, { uploadId: '123e4567-e89b-12d3-a456-426614174000' }]) {
    await assert.rejects(importBondLedgerUpload(new Request('https://example.com'), {}, input, () => assert.fail()), e => e.status === 400);
  }
});

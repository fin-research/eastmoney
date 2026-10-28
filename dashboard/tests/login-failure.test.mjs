import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GenericError, PopupCancelledError, PopupTimeoutError } from '@auth0/auth0-spa-js';
import { loginFailure, loginFailureFromCode } from '../src/lib/login-failure.ts';

test('SDK error code and description are preserved for plain text feedback', () => {
  const value = loginFailure(new GenericError('access_denied', '请先验证注册邮箱，再返回登录'));
  assert.equal(value.code, 'access_denied'); assert.equal(value.message, '请先验证注册邮箱，再返回登录');
  assert.equal(loginFailure(new PopupCancelledError({})).code, 'cancelled');
  assert.equal(loginFailure(new PopupTimeoutError({})).code, 'timeout');
  for (const description of ['用户被封禁', '<script>plain text</script>', '另一种自定义错误']) {
    assert.equal(loginFailure(new GenericError('access_denied', description)).message, description);
  }
  assert.equal(loginFailure(Error('网络连接中断')).message, '网络连接中断');
  assert.equal(loginFailure({error:'custom',error_description:''}).message, '登录未完成，请重试');
  assert.equal(loginFailure(null).kind, 'callback');
  assert.equal(loginFailureFromCode('https://evil.test').kind, 'callback');
});

test('dialog retains email feedback and the pending operation until verified retry or cancellation', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--conditions=browser', 'tests/helpers/login-verification.mjs'], {
    cwd: new URL('../', import.meta.url), timeout: 60_000,
  });
  assert.match(stdout, /Verification feedback persists and retry continues the original operation/);
});

import { expect, it } from 'vitest';
import { decodeExchangeBondCode, encodeExchangeBondCode } from '../src/sync/exchange-bond-code.ts';

it('round trips exchange codes, including leading zeros, extra codes and equal bodies on two markets', () => {
  for (const code of ['123456.SH', '123456.SZ', '000001.SH', '000001.SZ', '654321X2.SH', '654321X.SZ']) {
    expect(decodeExchangeBondCode(encodeExchangeBondCode(code))).toBe(code);
  }
  expect(encodeExchangeBondCode('123456.SH')).toBe(10123456);
  expect(encodeExchangeBondCode('123456.SZ')).toBe(20123456);
  expect(encodeExchangeBondCode('654321X2.SH')).toBe(12654321);
  expect(encodeExchangeBondCode('000001.SH')).toBe(10000001);
  expect(encodeExchangeBondCode('000001.SZ')).toBe(20000001);
});

it('rejects interbank and unsupported exchange codes', () => {
  expect(() => encodeExchangeBondCode('123456.IB')).toThrow();
  expect(() => encodeExchangeBondCode('1234567.SH')).toThrow();
  expect(() => decodeExchangeBondCode(30000000)).toThrow();
});

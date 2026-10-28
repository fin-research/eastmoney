import assert from 'node:assert/strict';
import test from 'node:test';
import { compareCreditInstitutionOrder, matchesCreditStatus } from '../src/lib/credit/presentation.ts';

test('credit default order uses bank categories and both current workbook aliases', () => {
  const categories=['外资行','农商行','未分类','国有银行','民营银行','股份行','政策性银行','城商行'];
  const rows=categories.map(institutionType=>({institutionType,institutionName:'银行'})).sort(compareCreditInstitutionOrder);
  assert.deepEqual(rows.map(i=>i.institutionType),['政策性银行','国有银行','股份行','城商行','农商行','民营银行','外资行','未分类']);
  assert.ok(compareCreditInstitutionOrder({institutionType:'国有行',institutionName:'乙'},{institutionType:'股份行',institutionName:'甲'})<0);
  assert.ok(compareCreditInstitutionOrder({institutionType:'境外行及外资行',institutionName:'乙'},{institutionType:'民营银行',institutionName:'甲'})>0);
});

test('default list includes applying institutions and hides revoked institutions, with explicit access to all statuses', () => {
  assert.equal(matchesCreditStatus('approved'),true);
  assert.equal(matchesCreditStatus('applying'),true);
  assert.equal(matchesCreditStatus('revoked'),false);
  assert.equal(matchesCreditStatus('revoked','all'),true);
  assert.equal(matchesCreditStatus('revoked','revoked'),true);
  assert.equal(matchesCreditStatus('applying','approved'),false);
});

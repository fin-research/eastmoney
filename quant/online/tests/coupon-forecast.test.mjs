import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { couponColumns, featureGroup, featureLabel, groups, issuerTerms, quoteDays, validateCouponModel, Refused } from '../coupon-forecast.mjs';

const columns = JSON.parse(await readFile(new URL('./fixtures/coupon-columns.json', import.meta.url), 'utf8'));
const toy = () => ({ kind: 'coupon_huber', columns, alpha: 300, mean: columns.map(() => 0), scale: columns.map(() => 1), coef: columns.map(() => 0.1), intercept: -1 });

test('the JS columns equal the Python columns and every one has a group and a label', () => {
  assert.deepEqual(couponColumns(), columns);
  for (const name of columns) {
    assert.ok(groups.includes(featureGroup(name)), name);
    if (name.includes('_')) assert.notEqual(featureLabel(name), name, name);
  }
});
test('invalid models are rejected', () => {
  validateCouponModel(toy());
  for (const change of [m => { m.scale[0] = 0; }, m => { m.coef.pop(); }, m => { m.kind = 'x'; }, m => { m.columns.reverse(); }, m => { m.intercept = NaN; }]) {
    const model = toy(); change(model);
    assert.throws(() => validateCouponModel(model));
  }
});
test('the issuer median needs two same-type issues public a full day earlier', () => {
  const history = [['2026-06-01', '证券公司债', 4], ['2026-06-11', '证券公司债', 8], ['2026-06-21', '证券公司债', 6], ['2026-07-01', '证券公司次级债', 20]]
    .map(([date, bond_type, dev], i) => ({ bond_code: String(i), bond_type, tender: date, label: date, dev, amount: 10 + i, rating: 'AAA' }));
  const [median, , rating, n] = issuerTerms(history, '2026-08-01', '证券公司债');
  assert.deepEqual([median, n, rating], [6, 3, 3]);
  assert.throws(() => issuerTerms(history, '2026-08-01', '证券公司次级债'), Refused);
  assert.equal(issuerTerms(history, '2026-06-22', '证券公司债')[3], 2);
});
test('a stale sector curve is refused', () => {
  const days = Array.from({ length: 40 }, (_, i) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10));
  const inputs = { as_of_date: '2026-10-20', required_source_date: '2026-10-09', datasets: { curve_days: days.map(d => ({ observation_date: d })) } };
  assert.throws(() => quoteDays(inputs), Refused);
});

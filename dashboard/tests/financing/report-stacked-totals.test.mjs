import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleStackedTotals } from '../../src/charts/financing/report.ts';

test('stacked totals follow visible legend items and preserve category order', () => {
  const rows = [
    { label: '甲', type: '公募债', value: 52 },
    { label: '甲', type: '次级债', value: 56 },
    { label: '乙', type: '公募债', value: 10 },
    { label: '乙', type: '次级债', value: 14 },
    { label: '甲', type: '未展示品种', value: 100 },
  ];
  const labels = ['乙', '甲', '丙'];
  const types = ['公募债', '次级债'];
  assert.deepEqual(visibleStackedTotals(rows, labels, types), [24, 108, 0]);
  assert.deepEqual(visibleStackedTotals(rows, labels, types, { 公募债: false }), [14, 56, 0]);
  assert.deepEqual(visibleStackedTotals(rows, labels, types, { 公募债: false, 次级债: false }), [0, 0, 0]);
  assert.deepEqual(visibleStackedTotals(rows, labels, types, { 公募债: true, 次级债: false }), [10, 52, 0]);
});

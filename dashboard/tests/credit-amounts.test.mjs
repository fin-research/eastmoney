import assert from 'node:assert/strict';
import test from 'node:test';
import { amountNumber, amountsDiffer, amountSumExceedsTolerance, secondaryUsageFromYuan, subtractAmounts, sumAmounts } from '../src/lib/credit/amounts.ts';

test('授信金额遵循 numeric 六位半入舍入，包括负二级余额',()=>{
  assert.equal(sumAmounts([23.1,-0.9]),22.2);
  assert.equal(subtractAmounts(47.22,22.2),25.02);
  assert.equal(sumAmounts([0.0000005]),0.000001);
  assert.equal(sumAmounts([-0.0000005]),-0.000001);
  assert.equal(sumAmounts([null,0]),0);
});

test('融资元金额保留分级精度，汇总和残差仅在授信结果边界归一',()=>{
  assert.equal(amountNumber('1.0000000101'),1.0000000101);
  assert.equal(sumAmounts(['0.00000049','0.00000049']),0.000001);
  assert.equal(secondaryUsageFromYuan('1.00000051','100000001.00'),0.000001);
  assert.equal(secondaryUsageFromYuan('1','100000050.00'),-0.000001);
});

test('金额比较先判断未舍入差额，101元变化保留、100元维持既有阈值',()=>{
  assert.equal(amountsDiffer('0.00000101',0),true);
  assert.equal(amountsDiffer(0,'0.00000101'),true);
  assert.equal(amountsDiffer('0.000001',0),false);
  assert.equal(amountSumExceedsTolerance([10,-9.99999899]),true);
  assert.equal(amountSumExceedsTolerance([10,-9.999999]),false);
});

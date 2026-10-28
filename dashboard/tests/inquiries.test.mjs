import assert from 'node:assert/strict';
import test from 'node:test';
import { blankInquiry, directoryKey, previousValues, fieldError, hasInquiryValue, invalidField, quotePrice, remember, shiborTenor, suggestions, tenorDays } from '../src/lib/trading-workflow/inquiries.ts';
const row = { ...blankInquiry(), counterparty:'工商银行', trader:'张三', tenor:'3', amount:'1.5', price:'10' };
const rates = [{ publishDate:'2026-09-15', publishedAt:'2026-09-15T11:00:00+08:00', tenor:'1W', rate:1.5 }];
test('loan quotes round tenor up and convert only against the published rate for that day', () => {
  assert.equal(shiborTenor('3D'),'1W'); assert.equal(shiborTenor('10天'),'2W'); assert.equal(shiborTenor('7'),'1W');
  assert.equal(shiborTenor('31'),'3M'); assert.equal(shiborTenor('366'),null); assert.equal(tenorDays('2W'),14);
  assert.equal(quotePrice(row,true,rates,'2026-09-15',new Date('2026-09-15T10:59:59+08:00')),'-10BP');
  assert.equal(quotePrice(row,true,rates,'2026-09-15',new Date('2026-09-15T11:00:00+08:00')),'1.4000%');
  assert.equal(quotePrice(row,true,rates,'2026-09-16',new Date('2026-09-16T12:00:00+08:00')),'-10BP');
  assert.equal(quotePrice({...row,price:'0'},true,rates,'2026-09-15',new Date('2026-09-15T12:00:00+08:00')),'1.5000%');
  assert.equal(quotePrice({...row,price:'1.45'},false,[], '2026-09-15',new Date()),'1.45%');
});
test('numeric suggestions preserve blank cells and offer recent valid values first', () => {
  const next = {...blankInquiry(), counterparty:'招商银行', price:'0'};
  assert.deepEqual(previousValues([row, next], next.id, 'tenor'), ['3']);
  assert.equal(next.tenor, '');
  assert.equal(invalidField(next,false),'tenor');
  assert.equal(invalidField({...row,price:'abc'},true),'price');
  assert.equal(fieldError('amount','0'), '金额须为大于零的数值');
  assert.equal(fieldError('amount','-1'), '金额须为大于零的数值');
  assert.equal(fieldError('price','0'), null);
  assert.equal(fieldError('price','1e4'), '价格须为有效数值');
  assert.equal(fieldError('tenor','1.1'), '期限须为正整数天数');
  assert.equal(tenorDays('999999999999999999999'), null);
  assert.equal(hasInquiryValue(blankInquiry()), false);
  assert.deepEqual(previousValues([row, {...row,id:'bad',amount:'abc'}, next], next.id, 'amount'), ['1.5']);
});
test('names match text, pinyin initials and partial initials; dictionary remains actor scoped', () => {
  const directory = remember({counterparties:[],traders:[]},row);
  assert.deepEqual(suggestions(directory.counterparties,'gsyh'),['工商银行']);
  assert.deepEqual(suggestions(directory.counterparties,'工商'),['工商银行']);
  assert.deepEqual(suggestions(directory.traders,'zs'),['张三']);
  assert.equal(remember(directory,row).counterparties.length,1);
  assert.notEqual(directoryKey('a'),directoryKey('b'));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { creditMaintenanceAmounts, creditMaintenanceChanges, creditMaintenanceDraft, setCreditBondUsage } from '../src/lib/credit/maintenance.ts';

const row = {
  institutionName:'甲银行',institutionType:'股份行',status:'approved',confidentialityStatus:true,
  reportDate:'2026-09-28',totalLimit:10,effectiveDate:'2026-01-01',expiryDate:'2027-01-01',
  clients:[{id:'1',name:'甲银行'}],items:[
    {type:'bond_investment',limitAmount:5,usedAmount:3,primaryUsedAmount:2,secondaryUsedAmount:1,details:'债券说明'},
    {type:'yield_certificate',limitAmount:3,usedAmount:1,details:null},
    {type:'interbank_lending',limitAmount:2,usedAmount:1,details:null},
    {type:'legal_overdraft',limitAmount:2,usedAmount:0.5,details:null},
    {type:'other',limitAmount:null,usedAmount:0.25,details:'手工记录'},
  ],
};

test('maintenance calculates total and item availability from editable values without inventing an other limit',()=>{
  const draft=creditMaintenanceDraft(row);
  draft.items.bond_investment.secondaryUsedAmount=2;
  draft.items.legal_overdraft.usedAmount=0.75;
  draft.items.other.usedAmount=0.5;
  draft.items.other.details='补充记录';
  const amount=creditMaintenanceAmounts(row,draft);
  assert.equal(amount.used.bond_investment,4);
  assert.equal(amount.remaining.bond_investment,1);
  assert.equal(amount.remaining.yield_certificate,2);
  assert.equal(amount.remaining.interbank_lending,1);
  assert.equal(amount.remaining.legal_overdraft,1.25);
  assert.equal(amount.remaining.other,null);
  assert.equal(amount.totalUsed,7.25);
  assert.equal(amount.available,2.75);
  const changes=creditMaintenanceChanges(row,draft);
  assert.equal(changes.institution,undefined);
  assert.deepEqual(changes.items,[
    {type:'bond_investment',secondaryUsedAmount:2},
    {type:'legal_overdraft',usedAmount:0.75},
    {type:'other',details:'补充记录',usedAmount:0.5},
  ]);
});

test('unlinked clients keep derived finance usage and available amount unknown',()=>{
  const unlinked={...row,clients:[],items:row.items.map(item=>item.type==='bond_investment'?{...item,primaryUsedAmount:null}:item)};
  const amount=creditMaintenanceAmounts(unlinked,creditMaintenanceDraft(unlinked));
  assert.equal(amount.used.bond_investment,null);
  assert.equal(amount.remaining.bond_investment,null);
  assert.equal(amount.totalUsed,null);
  assert.equal(amount.available,null);
});


test('bond used and available inputs reverse into signed secondary usage and preserve the primary source',()=>{
  const draft=creditMaintenanceDraft(row);
  setCreditBondUsage(row,draft,'used',1);
  assert.equal(draft.items.bond_investment.secondaryUsedAmount,-1);
  assert.equal(creditMaintenanceAmounts(row,draft).remaining.bond_investment,4);
  setCreditBondUsage(row,draft,'remaining',0);
  assert.equal(draft.items.bond_investment.secondaryUsedAmount,3);
  assert.equal(creditMaintenanceAmounts(row,draft).used.bond_investment,5);
  draft.items.bond_investment.limitAmount=8;
  assert.equal(creditMaintenanceAmounts(row,draft).remaining.bond_investment,3);
  setCreditBondUsage(row,draft,'used',0);
  assert.equal(draft.items.bond_investment.secondaryUsedAmount,-2);
  assert.deepEqual(creditMaintenanceChanges(row,draft).items,[{type:'bond_investment',limitAmount:8,secondaryUsedAmount:-2}]);
  setCreditBondUsage(row,draft,'used',2.123456);
  assert.equal(draft.items.bond_investment.secondaryUsedAmount,.123456);
  const unlinked={...row,clients:[],items:row.items.map(item=>({...item,primaryUsedAmount:null}))};
  const missing=creditMaintenanceDraft(unlinked);
  setCreditBondUsage(unlinked,missing,'used',8);
  assert.equal(missing.items.bond_investment.secondaryUsedAmount,1);
  assert.equal(creditMaintenanceAmounts(unlinked,missing).used.bond_investment,null);
});

test('建信理财金额联动使用十进制，编辑后反算二级余额不会产生伪变更',()=>{
  const institution={...row,institutionName:'建信理财',totalLimit:101.25,items:row.items.map(item=>
    item.type==='bond_investment'?{...item,limitAmount:47.22,usedAmount:22.2,primaryUsedAmount:23.1,secondaryUsedAmount:-0.9}:
    {...item,usedAmount:item.type==='yield_certificate'?3.1:item.type==='interbank_lending'?0.2:item.type==='legal_overdraft'?0.3:null})};
  const draft=creditMaintenanceDraft(institution);
  const amount=creditMaintenanceAmounts(institution,draft);
  assert.equal(amount.used.bond_investment,22.2);
  assert.equal(amount.remaining.bond_investment,25.02);
  assert.equal(amount.totalUsed,25.8);
  assert.equal(amount.available,75.45);
  setCreditBondUsage(institution,draft,'used',22.2);
  assert.deepEqual(creditMaintenanceChanges(institution,draft),{});
  setCreditBondUsage(institution,draft,'remaining',25.02);
  assert.deepEqual(creditMaintenanceChanges(institution,draft),{});
  setCreditBondUsage(institution,draft,'remaining',30);
  assert.equal(draft.items.bond_investment.secondaryUsedAmount,-5.88);
  assert.equal(creditMaintenanceAmounts(institution,draft).used.bond_investment,17.22);
});

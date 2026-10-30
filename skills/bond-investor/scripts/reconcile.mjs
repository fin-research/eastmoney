// node reconcile.mjs draft.json
// { registrations:[{id,bond,amount}], penetrations:[{id,bond,amount}],
//   bonds:[{bond,amount}], allocations:[{registrationId,penetrationId,amount}], unresolved:[] }
// All amounts are yuan decimal strings (up to two decimals); IDs are source row references.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
export function reconcile(draft) {
  const cents = value => {
    if (typeof value !== 'string' || !/^\d+(\.\d{1,2})?$/.test(value)) throw Error('金额必须为元的正十进制字符串');
    const [whole, part = ''] = value.split('.');
    const result = BigInt(whole) * 100n + BigInt(part.padEnd(2, '0'));
    if (result <= 0n) throw Error('金额必须大于零');
    return result;
  };
  if (!Array.isArray(draft.unresolved) || draft.unresolved.length) throw Error('未决项未清零');
  const index = (rows, field) => {
    const map = new Map();
    for (const row of rows) {
      if (!row[field] || map.has(row[field])) throw Error('来源键缺失或重复');
      map.set(row[field], { ...row, expected: cents(row.amount), actual: 0n });
    }
    if (!map.size) throw Error('来源为空');
    return map;
  };
  const registrations = index(draft.registrations, 'id');
  const penetrations = index(draft.penetrations, 'id');
  const bonds = index(draft.bonds, 'bond');
  for (const edge of draft.allocations) {
    const r = registrations.get(edge.registrationId), p = penetrations.get(edge.penetrationId);
    if (!r || !p || r.bond !== p.bond || !bonds.has(r.bond)) throw Error('来源不存在或跨债券分配');
    const amount = cents(edge.amount);
    r.actual += amount; p.actual += amount; bonds.get(r.bond).actual += amount;
  }
  for (const map of [registrations, penetrations, bonds]) {
    for (const [key, row] of map) if (row.actual !== row.expected) throw Error(`${key} 金额不闭合`);
  }
  return { registrationRows: registrations.size, penetrationRows: penetrations.size, bonds: bonds.size, allocations: draft.allocations.length };
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const bytes = fs.readFileSync(process.argv[2]);
  console.log(JSON.stringify({ ...reconcile(JSON.parse(bytes)), sha256: createHash('sha256').update(bytes).digest('hex') }));
}

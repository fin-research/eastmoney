import { expect, it, vi } from 'vitest';

// Wire type 12 decodes an empty string as null; the vendor metadata has rows with empty cells.
vi.mock('../src/choice/native/wire.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/choice/native/wire.ts')>(),
  decodeChoiceSheets: () => [{
    name: 'EM_API_PERCENTFLAG', columns: ['ENGNAME_API', 'EOIFUNCTION', 'STYPE'], types: [12, 12, 12],
    rows: [['PCT', 'EM_CSS', '(1,2)'], ['NOFLAG', 'EM_CSS', null], [null, null, null], ['OTHER', null, '(1)']],
  }],
}));

import { decodePercentMetadata, percentFlags } from '../src/choice/native/percent.ts';

it('skips metadata rows with empty cells instead of failing the whole table', () => {
  const metadata = decodePercentMetadata(new Uint8Array());
  expect(percentFlags(metadata, 'CSS', ['PCT', 'NOFLAG', 'OTHER'], 1)).toEqual([true, false, false]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { superValidate } from 'sveltekit-superforms/server';
import { zod4 } from 'sveltekit-superforms/adapters';
import { projectCreateSchema } from '../../src/lib/financing/project-form.ts';

const valid = { name: '项目一', sopTemplateId: 'sop-bond', plannedBookbuildingDate: '2028-02-29', amountYi: '12.34567890' };
const validate = values => superValidate(new URLSearchParams(values), zod4(projectCreateSchema));

test('project form accepts native posted data, trims fields and keeps optional blanks', async () => {
  const result = await validate({ ...valid, name: '  项目一  ', amountYi: '' });
  assert.equal(result.valid, true);
  assert.equal(result.data.name, '项目一');
  assert.equal(result.data.amountYi, '');
  assert.equal(result.data.ownerId, '');
  assert.equal(result.data.notes, '');
});

test('project form rejects invalid dates and scales while preserving the posted draft', async () => {
  for (const patch of [
    { name: '   ' }, { sopTemplateId: '' }, { plannedBookbuildingDate: '' },
    { plannedBookbuildingDate: '2027-02-29' }, { amountYi: '-1' },
    { amountYi: '1e5' }, { amountYi: '0.123456789' }, { notes: 'a'.repeat(4001) }
  ]) {
    const result = await validate({ ...valid, ...patch });
    const field = Object.keys(patch)[0];
    assert.equal(result.valid, false, field);
    assert.ok(result.errors[field]?.length, field);
    assert.equal(result.data.sopTemplateId, patch.sopTemplateId ?? valid.sopTemplateId);
    assert.equal(result.data.name, (patch.name ?? valid.name));
  }
});

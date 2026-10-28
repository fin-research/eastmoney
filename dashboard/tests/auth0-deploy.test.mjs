import assert from 'node:assert/strict';
import test from 'node:test';
import { deploymentArguments } from '../scripts/auth0-deploy.mjs';

test('Deploy CLI plans stay read-only and resource scope is explicit', () => {
  assert.throws(() => deploymentArguments(['export']), /include/);
  assert.throws(() => deploymentArguments(['apply', '--include=branding']), /input/);
  assert.throws(() => deploymentArguments(['apply', '--include=branding', '--input=x', '--debug=true']), /unique/);
  const plan = deploymentArguments(['plan', '--include=branding,prompts', '--input=.auth0-deploy/export/tenant.yaml'], '/workspace');
  assert.deepEqual(plan.included, ['branding', 'prompts']);
  assert.ok(plan.command.includes('--dry-run')); assert.ok(!plan.command.includes('--apply'));
  const apply = deploymentArguments(['apply', '--include=branding', '--input=tenant.yaml'], '/workspace');
  assert.ok(apply.command.includes('--dry-run')); assert.ok(apply.command.includes('--apply'));
  assert.deepEqual(deploymentArguments(['export', '--', '--include=branding'], '/workspace').command,
    ['export', '--format=yaml', '--output_folder=/workspace/.auth0-deploy/export']);
});

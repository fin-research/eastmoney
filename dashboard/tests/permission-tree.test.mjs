import test from 'node:test';
import assert from 'node:assert/strict';
import { permissionTree } from '../src/lib/permissions/permission-tree.ts';
import { PERMISSION_CODES } from '../src/lib/permissions.ts';
test('every registered permission appears exactly once under scope, resource and action',()=>{
  const tree=permissionTree(PERMISSION_CODES);
  const codes=tree.flatMap(group=>group.resources.flatMap(resource=>resource.actions.map(action=>{
    assert.equal(action.code,`${group.scope}.${resource.id}:${action.action}`);assert.equal(action.granted,true);return action.code;
  })));
  assert.deepEqual(codes.sort(),[...PERMISSION_CODES].sort());
});
test('personal view only exposes granted operations and search includes all hierarchy levels',()=>{
  const codes=['financing.task:update_own'];
  const tree=permissionTree(codes,'',true);
  assert.equal(tree.length,1);assert.equal(tree[0].resources.length,1);assert.equal(tree[0].resources[0].actions[0].name,'办理本人任务');
  assert.equal(permissionTree(codes,'本人',true).length,1);
  assert.equal(permissionTree(codes,'credit',true).length,0);
  assert.deepEqual(permissionTree(['invented:admin'],'',true),[]);
});

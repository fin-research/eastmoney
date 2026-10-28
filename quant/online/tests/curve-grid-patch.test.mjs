import test from 'node:test';
import assert from 'node:assert/strict';
import {OLD_GRID_BLOCK,OLD_INPUT_READ,patchCurveGridRuntime} from '../curve-grid-patch.mjs';
test('production patch changes transport only and retains both size limits',()=>{
 const source=`before\n${OLD_GRID_BLOCK}\nbetween\n${OLD_INPUT_READ}\nafter`;
 const patched=patchCurveGridRuntime(source);
 assert.ok(patched.includes('before\n'));
 assert.ok(patched.includes('\nbetween\n'));
 assert.ok(patched.endsWith('\nafter'));
 assert.ok(patched.includes('16 * 1024 * 1024'));
 assert.ok(patched.includes('32 * 1024 * 1024'));
 assert.throws(()=>patchCurveGridRuntime(patched));
 assert.throws(()=>patchCurveGridRuntime(source+'\n'+OLD_INPUT_READ));
 assert.throws(()=>patchCurveGridRuntime(source.replace('datasets[group]','changed[group]')));
});

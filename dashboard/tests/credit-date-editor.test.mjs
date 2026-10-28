import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import test from 'node:test';

test('授信一览表详情由管理员显式保存维护事件',async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,['--conditions=browser','tests/helpers/credit-date-editor-ui.mjs'],{cwd:new URL('../',import.meta.url),timeout:60_000});
  assert.match(stdout,/Credit editable detail and role checks passed/);
});

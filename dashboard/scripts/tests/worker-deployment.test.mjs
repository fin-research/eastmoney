import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentStatus, readDeploymentStatus } from '../lib/worker-deployment.mjs';
const commit = 'a'.repeat(40), old = 'b'.repeat(40);
const build = (sha, outcome = 'success', status = 'stopped') => ({ build_uuid: `build-${sha[0]}`,
  created_on: '2026-10-09T07:02:00Z', status, build_outcome: outcome,
  build_trigger_metadata: { commit_hash: sha, branch: 'main' } });
const data = (versions = [{version_id:'active',percentage:100}]) => ({
  deployments: [{created_on:'2026-10-09T07:06:00Z',versions}], builds:[build(commit)],
  versionBuilds: { active: build(commit) },
});
test('active version resolves through Build commit despite missing SHA annotations and wrangler source', () => {
  assert.equal(deploymentStatus(data(),commit).state,'deployed');
});
test('successful historical Build cannot prove a later unknown/manual version is active', () => {
  const d=data([{version_id:'manual',percentage:100}]);
  assert.equal(deploymentStatus(d,commit).state,'unknown');
});
test('mixed traffic and missing traffic cannot count as fully deployed', () => {
  const d=data([{version_id:'active',percentage:90},{version_id:'old',percentage:10}]);
  d.versionBuilds.old=build(old);assert.equal(deploymentStatus(d,commit).state,'unknown');
  assert.equal(deploymentStatus(data([{version_id:'active',percentage:90}]),commit).state,'unknown');
});
test('newest deployment controls status; queued main Builds block manual fallback', () => {
  const d=data();d.deployments.unshift({created_on:'2026-10-09T08:00:00Z',versions:[{version_id:'later',percentage:100}]});
  d.builds=[build(commit,'fail'),build(old,null,'running')];
  assert.equal(deploymentStatus(d,commit).state,'pending');
  d.builds=[build(commit,'fail')];assert.equal(deploymentStatus(d,commit).state,'failed');
});
test('cancelled/superseded builds and absent builds stay unknown', () => {
  const d=data();d.versionBuilds={};
  d.builds=[build(commit,'canceled')];assert.equal(deploymentStatus(d,commit).state,'unknown');
  d.builds=[];assert.equal(deploymentStatus(d,commit).state,'unknown');
});
test('guarded manual SHA tags are traceable; arbitrary labels do not establish Git identity', () => {
  const d=data();d.versionBuilds={};d.versions={active:{annotations:{'workers/tag':`git:${commit}`}}};
  assert.equal(deploymentStatus(d,commit).state,'deployed');
  d.versions.active.annotations['workers/tag']='credit-fixed';assert.equal(deploymentStatus(d,commit).state,'unknown');
});
test('API permission errors fail closed and never expose credentials or infer build failure', async () => {
  const fetchImpl=async()=>({ok:false,status:403,json:async()=>({success:false,errors:[{message:'private token'}]})});
  await assert.rejects(readDeploymentStatus({account:'fixture',worker:'fixture',commit,token:'private token',fetchImpl}), /^Error: Cloudflare deployment verification failed \(HTTP 403\)\.$/);
});
test('a pending Build on a later page prevents a manual fallback after an apparent failure', async () => {
  const paths=[];
  const fetchImpl=async url=>{
    const path=new URL(url).pathname+new URL(url).search;paths.push(path);
    const result=path.endsWith('/workers/scripts')?[{id:'fixture',tag:'tag'}]
      :path.endsWith('/deployments')?{deployments:data().deployments}
      :path.includes('page=1')?[build(commit,'fail')]
      :path.includes('page=2')?[build(old,null,'running')]
      :path.includes('version_ids=')?{builds:{}}
      :{annotations:{}};
    return {ok:true,status:200,json:async()=>({success:true,result,
      ...(path.includes('/tag/builds?')?{result_info:{next_page:path.includes('page=1')}}:{})})};
  };
  const status=await readDeploymentStatus({account:'fixture',worker:'fixture',commit,token:'fixture',fetchImpl});
  assert.equal(status.state,'pending');assert.ok(paths.some(p=>p.includes('page=2')));
});
test('missing pagination metadata stays unknown rather than authorizing a manual deploy', async () => {
  const fetchImpl=async url=>({ok:true,status:200,json:async()=>({success:true,result:
    url.endsWith('/workers/scripts')?[{id:'fixture',tag:'tag'}]:url.endsWith('/deployments')?{deployments:[]}:[]})});
  await assert.rejects(readDeploymentStatus({account:'fixture',worker:'fixture',commit,token:'fixture',fetchImpl}),/pagination is incomplete/);
});

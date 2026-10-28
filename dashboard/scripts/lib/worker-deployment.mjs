/** Version UUIDs identify uploads; Builds supplies the Git commit behind them. */
export function deploymentStatus({ deployments, builds, versionBuilds, versions = {} }, commit) {
  const deployment = [...deployments].sort((a, b) => b.created_on.localeCompare(a.created_on))[0];
  const active = (deployment?.versions ?? []).filter(v => v.percentage > 0).map(v => {
    const build = versionBuilds[v.version_id];
    const tag = versions[v.version_id]?.annotations?.['workers/tag'];
    return { version: v.version_id, percentage: v.percentage,
      commit: build?.build_trigger_metadata?.commit_hash ?? (/^git:[a-f0-9]{40}$/.test(tag ?? '') ? tag.slice(4) : null),
      build: build?.build_uuid ?? null };
  });
  const ordered = [...builds].sort((a, b) => b.created_on.localeCompare(a.created_on));
  const target = ordered.find(b => b.build_trigger_metadata?.commit_hash === commit && b.build_trigger_metadata?.branch === 'main');
  const pending = ordered.filter(b => b.status !== 'stopped'
    && b.build_trigger_metadata?.branch === 'main');
  const deployed = active.length > 0 && active.reduce((n, v) => n + v.percentage, 0) === 100
    && active.every(v => v.commit === commit);
  const state = deployed ? 'deployed' : pending.length ? 'pending'
    : target?.status === 'stopped' && target.build_outcome === 'fail' ? 'failed' : 'unknown';
  return { state, commit, active, targetBuild: target ? { id: target.build_uuid, status: target.status,
    outcome: target.build_outcome ?? null } : null, pendingBuilds: pending.map(b => ({ id: b.build_uuid,
    commit: b.build_trigger_metadata?.commit_hash, status: b.status })) };
}

export async function readDeploymentStatus({ account, worker, commit, token, fetchImpl = fetch }) {
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required for deployment verification.');
  const get = async path => {
    const r = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000),
    });
    const b = await r.json();
    if (!r.ok || !b.success) throw new Error(`Cloudflare deployment verification failed (HTTP ${r.status}).`);
    return b;
  };
  const scripts = (await get('/workers/scripts')).result;
  const tag = scripts.find(s => s.id === worker)?.tag;
  if (!tag) throw new Error('Worker tag is unavailable; deployment state is unknown.');
  const builds = [];
  for (let page = 1; ; page++) {
    const b = await get(`/builds/workers/${tag}/builds?page=${page}&per_page=50`);
    if (!Array.isArray(b.result)) throw new Error('Unsupported Build response.');
    builds.push(...b.result);
    if (b.result_info?.next_page === false) break;
    if (b.result_info?.next_page !== true || page >= 100) throw new Error('Build pagination is incomplete; deployment state is unknown.');
  }
  // Read active traffic after the paginated history, which can take several seconds.
  const deploymentResult = (await get(`/workers/scripts/${worker}/deployments`)).result;
  const deployments = deploymentResult.deployments;
  if (!Array.isArray(deployments) || !Array.isArray(builds)) throw new Error('Unsupported deployment response; state is unknown.');
  const latest = [...deployments].sort((a, b) => b.created_on.localeCompare(a.created_on))[0];
  const ids = (latest?.versions ?? []).filter(v => v.percentage > 0).map(v => v.version_id);
  const versionBuilds = ids.length ? (await get(`/builds/builds?version_ids=${ids.join(',')}`)).result.builds : {};
  if (!versionBuilds || Array.isArray(versionBuilds)) throw new Error('Version to Build mapping is unavailable.');
  const versions = Object.fromEntries(await Promise.all(ids.filter(id => !versionBuilds[id]).map(async id =>
    [id, (await get(`/workers/scripts/${worker}/versions/${id}`)).result])));
  return deploymentStatus({ deployments, builds, versionBuilds, versions }, commit);
}

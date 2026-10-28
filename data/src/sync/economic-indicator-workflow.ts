import { saveEdbResponse } from './edb-response-evidence.ts';
import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { handleRequest } from '../app.ts';
import type { DataApiRequest, EconomicIndicatorSyncParams } from './economic-indicator-sync.ts';
import { persistEconomicIndicators } from './economic-indicators-repository.ts';
import { requestEconomicIndicatorData } from './economic-indicator-request.ts';
import { withPostgres } from './postgres.ts';
import { runEconomicIndicatorSync } from './economic-indicator-run.ts';
import { runQuantInputSync } from './quant-input-run.ts';
import { replayIssuanceObservations } from './issuance-observation-replay.ts';
import { notifyDmFundingParent, runDmFundingChild, type DmFundingSyncParams } from './dm-funding-child.ts';
import { runDailyBondRecovery, startDailyBondRecovery, dailyRecoveryIdentity, quotaUnavailable } from './bond-history-daily-recovery.ts';
import {runBondFieldObservation} from './bond-field-observation.ts';
import { runBondHistoryWorkflowRecovery } from './bond-history-workflow-recovery.ts';

export class EconomicIndicatorSyncWorkflow extends WorkflowEntrypoint<Cloudflare.Env, EconomicIndicatorSyncParams> {
  override async run(event: Readonly<WorkflowEvent<EconomicIndicatorSyncParams>>, step: WorkflowStep) {
    if(event.payload?.bondFieldObservationPlan!==undefined){
      if(event.payload.bondHistoryRecoveryOf!==undefined||event.payload.issuanceReplayOf!==undefined)throw Error('Conflicting Workflow observation/recovery modes');
      return runBondFieldObservation(step,this.env,event.instanceId,event.payload.bondFieldObservationPlan,
        (path,parameters,capture)=>requestEconomicIndicatorData({fetch:input=>handleRequest(input,this.env)},path,parameters,capture),
        operation=>withPostgres(this.env.HYPERDRIVE.connectionString,'bond-field-observation-readonly',operation));
    }
    if (event.payload?.bondHistoryRecoveryOf !== undefined) {
      if (event.payload.issuanceReplayOf !== undefined) throw new Error('Conflicting Workflow recovery modes');
      const request: DataApiRequest = (path, parameters, capture) => requestEconomicIndicatorData({ fetch: input => handleRequest(input, this.env) }, path, parameters, capture);
      if (event.instanceId === dailyRecoveryIdentity(event.payload.bondHistoryRecoveryOf).id)
        return runDailyBondRecovery(step, this.env, event.instanceId, event.payload.bondHistoryRecoveryOf, request);
      return runBondHistoryWorkflowRecovery(step, this.env, event.instanceId, event.payload.bondHistoryRecoveryOf,
        (path, parameters, capture) => requestEconomicIndicatorData({ fetch: input => handleRequest(input, this.env) }, path, parameters, capture));
    }
    if (event.payload?.issuanceReplayOf !== undefined) {
      return step.do('恢复已归档发行观察', { retries: { limit: 0, delay: '1 second' }, timeout: '10 minutes' },
        () => replayIssuanceObservations(this.env.EASTMONEY,
          operation => withPostgres(this.env.HYPERDRIVE.connectionString,'issuance-observation-replay',operation),
          event.payload.issuanceReplayOf!,event.instanceId));
    }
    const scheduledTime = event.payload?.scheduledTime ?? event.schedule?.scheduledTime ?? event.timestamp.getTime();
    const request: DataApiRequest = (path, parameters, capture) => requestEconomicIndicatorData(
      { fetch: (input) => handleRequest(input, this.env) }, path, parameters, capture,
    );
    // Release dependent calculations after Choice writes, independently of DM.
    let releaseChoice!: () => void;
    const choiceReady = new Promise<void>(resolve => { releaseChoice = resolve; });
    const settled = await Promise.allSettled([
      runEconomicIndicatorSync(step, event.instanceId, scheduledTime, request,
        (rows) => withPostgres(this.env.HYPERDRIVE.connectionString, 'eastmoney-edb-workflow',
          (client) => persistEconomicIndicators(client, rows)),
        { archive: (spec, attempt, evidence) => saveEdbResponse(this.env.EASTMONEY, event.instanceId, scheduledTime, spec, attempt, evidence),
          choiceSettled: () => releaseChoice(),
          dmGroup: () => runDmFundingChild(step, this.env.DM_FUNDING_SYNC, event.instanceId, scheduledTime) })
        .finally(() => releaseChoice()),
      runQuantInputSync(step, this.env, scheduledTime, request, event.instanceId, choiceReady),
    ]);
    const [indicatorRun, quantRun] = settled;
    if (indicatorRun.status === 'rejected') throw indicatorRun.reason;
    if (quantRun.status === 'rejected') throw quantRun.reason;
    const indicators = indicatorRun.value, quant = quantRun.value;
    const result = { ...indicators, groups: [...indicators.groups, ...quant.groups],
      status: indicators.status === 'failed' ? 'failed' : indicators.status === 'partial' || quant.status === 'partial' ? 'partial' : 'complete', quant };
    await step.do('汇总同步结果', async () => {
      const log = result.status === 'complete' ? console.log : console.error;
      log(JSON.stringify({ event: 'economic_indicators_workflow_result', ...result }));
      return result;
    });
    if (quotaUnavailable(result)) await step.do('登记唯一逐债估值日内补偿', { retries: { limit: 0, delay: '1 second' } },
      () => startDailyBondRecovery(this.env, event.instanceId, result));
    if (result.status === 'failed') throw new Error(JSON.stringify(result));
    return result;
  }
}

export class DmFundingSyncWorkflow extends WorkflowEntrypoint<Cloudflare.Env, DmFundingSyncParams> {
  override async run(event: Readonly<WorkflowEvent<DmFundingSyncParams>>, step: WorkflowStep) {
    const { scheduledTime, parentInstanceId } = event.payload;
    const result = await runEconomicIndicatorSync(step, event.instanceId, scheduledTime,
      (path, parameters, capture) => requestEconomicIndicatorData({ fetch: input => handleRequest(input, this.env) }, path, parameters, capture),
      rows => withPostgres(this.env.HYPERDRIVE.connectionString, 'eastmoney-dm-funding-workflow',
        client => persistEconomicIndicators(client, rows)), { dmOnly: true });
    // A business failure is a valid result; the parent retains per-request details.
    const group = result.groups[0]!;
    await notifyDmFundingParent(step, this.env.ECONOMIC_INDICATOR_SYNC, event.instanceId, event.payload, group);
    return { parentInstanceId, scheduledTime, group };
  }
}

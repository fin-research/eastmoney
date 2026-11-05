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

export class EconomicIndicatorSyncWorkflow extends WorkflowEntrypoint<Cloudflare.Env, EconomicIndicatorSyncParams> {
  override async run(event: Readonly<WorkflowEvent<EconomicIndicatorSyncParams>>, step: WorkflowStep) {
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
          choiceSettled: () => releaseChoice() })
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
    if (result.status === 'failed') throw new Error(JSON.stringify(result));
    return result;
  }
}

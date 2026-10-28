import type { EconomicIndicatorSyncParams } from "./economic-indicator-sync.ts";
import { loadTradingDay } from "../trading-calendar.ts";

export function economicIndicatorWorkflowInstanceId(scheduledTime: number): string {
  return `economic-indicator-sync-${scheduledTime}`;
}

export async function startEconomicIndicatorSyncWorkflow(
  env: Cloudflare.Env,
  scheduledTime: number,
): Promise<string> {
  const workflow = env.ECONOMIC_INDICATOR_SYNC;
  const id = economicIndicatorWorkflowInstanceId(scheduledTime);
  const params: EconomicIndicatorSyncParams = { scheduledTime };
  try {
    const instance = await workflow.create({
      id,
      params,
      retention: {
        successRetention: "30 days",
        errorRetention: "90 days",
      },
      locationHint: "apac",
    });
    console.log(
      JSON.stringify({
        event: "economic_indicators_workflow_started",
        workflowInstanceId: instance.id,
        scheduledTime,
      }),
    );
    return instance.id;
  } catch (error) {
    // Cron delivery can be repeated. Treat an already-created instance as
    // success so a duplicate delivery does not create a second run or hide
    // the original instance from the Workflow history.
    try {
      const existing = await workflow.get(id);
      const status = await existing.status();
      console.log(
        JSON.stringify({
          event: "economic_indicators_workflow_already_started",
          workflowInstanceId: id,
          scheduledTime,
          status: status.status,
        }),
      );
      return id;
    } catch {
      console.error(
        JSON.stringify({
          event: "economic_indicators_workflow_dispatch_failed",
          workflowInstanceId: id,
          scheduledTime,
          error: errorMessage(error),
        }),
      );
      throw error;
    }
  }
}

/*
 * Confirm the scheduled Shanghai date before creating a durable instance.
 * Business requests and database writes remain in Workflow steps.
 */
export async function runEconomicIndicatorScheduledSync(
  env: Cloudflare.Env,
  scheduledTime: number,
): Promise<void> {
  if (!Number.isSafeInteger(scheduledTime) || scheduledTime < 60_000
    || !Number.isFinite(new Date(scheduledTime).getTime())) throw new Error('Invalid scheduled time');
  scheduledTime = Math.floor(scheduledTime / 60_000) * 60_000;
  const local = new Date(scheduledTime + 8 * 3600_000);
  const date = local.toISOString().slice(0, 10);
  if ([0, 6].includes(local.getUTCDay())) {
    console.log(JSON.stringify({ event: "economic_indicators_cron_skipped", date, reason: "weekend" }));
    return;
  }
  let calendar;
  try { calendar = await loadTradingDay(env, date); }
  catch (error) {
    console.error(JSON.stringify({ event: "economic_indicators_calendar_unavailable", date }));
    throw error;
  }
  if (!calendar.isTradingDay) {
    console.log(JSON.stringify({ event: "economic_indicators_cron_skipped", date, reason: "market_closed" }));
    return;
  }
  await startEconomicIndicatorSyncWorkflow(env, scheduledTime);
  console.log(
    JSON.stringify({
      event: "economic_indicators_workflow_dispatch_complete",
      workflowInstanceId: economicIndicatorWorkflowInstanceId(scheduledTime),
      scheduledTime,
    }),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

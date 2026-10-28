import { scheduledTasks } from './scheduled-tasks.ts';
import { runEconomicIndicatorScheduledSync } from './sync/economic-indicator-scheduled.ts';
export { EconomicIndicatorSyncWorkflow, DmFundingSyncWorkflow } from './sync/economic-indicator-workflow.ts';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { handleRequest } from "./app";
import { handleCamelRequest } from "./camel/routes";
import { handleGatewayRequest, handlePublicRequest } from './public-access';

export { handleRequest } from "./app";

// A named entrypoint is only reachable through an explicitly provisioned binding.
// Neither an HTTP path nor a caller-supplied header selects this entrypoint.
export class InternalData extends WorkerEntrypoint<Cloudflare.Env> {
  override async fetch(request: Request): Promise<Response> {
    return await handleCamelRequest(request, this.env) ?? handleRequest(request, this.env);
  }
}

export class GatewayData extends WorkerEntrypoint<Cloudflare.Env> {
  override fetch(request: Request): Promise<Response> { return handleGatewayRequest(request, this.env); }
}

export class ScheduledTasks extends WorkerEntrypoint<Cloudflare.Env> {
  override fetch(request: Request) { return scheduledTasks(request, this.env); }
}

export default {
  fetch: handlePublicRequest,
  scheduled(controller, env, ctx) {
    if (controller.cron !== "0 16 * * *") return;
    controller.noRetry();
    ctx.waitUntil(runEconomicIndicatorScheduledSync(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Cloudflare.Env>;

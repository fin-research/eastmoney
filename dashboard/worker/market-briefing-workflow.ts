import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { runMarketBriefing, type MarketBriefingParams } from "./market-briefing-runner.ts";

export class MarketBriefingWorkflow extends WorkflowEntrypoint<Env, MarketBriefingParams> {
  async run(event: Readonly<WorkflowEvent<MarketBriefingParams>>, step: WorkflowStep) {
    return await runMarketBriefing(this.env, step, event.payload);
  }
}

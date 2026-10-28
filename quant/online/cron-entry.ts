import { WorkerEntrypoint } from 'cloudflare:workers';
import { scheduledTasks } from './scheduled-tasks.ts';
export { BondInferenceWorkflow } from "./worker";
export { ResearchReport } from "./report";
import { startScheduledInference } from "./scheduled";

export class ScheduledTasks extends WorkerEntrypoint<Env> {
  override fetch(request: Request) { return scheduledTasks(request, this.env); }
}

export default {
  fetch() { return new Response("Not found", { status: 404 }); },
  async scheduled(event: ScheduledController, env: Env) {
    await startScheduledInference(env, event.scheduledTime);
  },
} satisfies ExportedHandler<Env>;

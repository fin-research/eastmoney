import { WorkerEntrypoint } from 'cloudflare:workers';
import { serveResearchReport } from './report.mjs';

export class ResearchReport extends WorkerEntrypoint<Env> {
  fetch(request: Request) {
    return serveResearchReport(request, this.env.ASSETS);
  }
}

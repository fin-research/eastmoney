import { error, redirect } from "@sveltejs/kit";

import {
  workbenchRoutes,
  type WorkbenchViewId,
} from "$lib/trading-research/demo-data";

export const ssr = false;

export function load({ params, url }: { params: { view: string }; url: URL }): {
  view: WorkbenchViewId;
} {
  if (params.view === "credit") redirect(307, "/credit-workbench" + url.search);
  if (params.view === "credit-assistant") redirect(307, "/?ai=open");
  const view = workbenchRoutes.find((candidate) => candidate.id === params.view);
  if (!view || view.id === "overview") error(404, "工作台标签页不存在");
  return { view: view.id };
}

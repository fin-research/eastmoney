import type { WorkbenchIconName } from "../trading-research/demo-data.ts";

export type CreditWorkbenchViewId = "overview" | "ledger" | "calendar" | "weekly";
export const creditWorkbenchViews: Array<{ id: CreditWorkbenchViewId; label: string; icon: WorkbenchIconName; href: string }> = [
  { id: "overview", label: "授信总览", icon: "overview", href: "/credit-workbench" },
  { id: "ledger", label: "授信一览表", icon: "credit", href: "/credit-workbench/ledger" },
  { id: "calendar", label: "授信日历", icon: "calendar", href: "/credit-workbench/calendar" },
  { id: "weekly", label: "授信周报", icon: "file", href: "/credit-workbench/weekly" },
];

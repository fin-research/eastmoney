export const creditItemTypes = [
  "bond_investment",
  "yield_certificate",
  "legal_overdraft",
  "interbank_lending",
  "other",
] as const;

export type CreditItemType = (typeof creditItemTypes)[number];

export const creditItemLabels: Record<CreditItemType, string> = {
  bond_investment: "债券投资",
  yield_certificate: "收益凭证",
  legal_overdraft: "法透",
  interbank_lending: "同业拆借",
  other: "其它",
};

export const creditStatuses = ["approved", "applying", "revoked"] as const;
export type CreditStatus = (typeof creditStatuses)[number];
export type ConfidentialityStatus = boolean;

export interface ParsedCreditItem {
  type: CreditItemType;
  limitAmount: number | null;
  usedAmount: number | null;
  remainingAmount: number | null;
  details: string | null;
}

export interface ParsedCreditInstitution {
  institutionType: string;
  institutionName: string;
  confidentialityStatus: ConfidentialityStatus;
  status: CreditStatus;
  totalLimit: number | null;
  totalUsed: number | null;
  totalRemaining: number | null;
  effectiveDate: string | null;
  expiryDate: string | null;
  bankOffice: string | null;
  applyingDepartment: string | null;
  handler: string | null;
  detail: string | null;
  bondPreference: string | null;
  notes: string | null;
  items: ParsedCreditItem[];
}

export interface ParsedCreditWorkbook {
  reportDate: string;
  originalFileName: string;
  sourceSheet: "授信一览表";
  institutions: ParsedCreditInstitution[];
  approvedCount: number;
  totalLimit: number;
  totalUsed: number;
  totalAvailable: number;
  weeklyApprovedCount: number;
  weeklyTotalLimit: number;
  weeklyTotalUsed: number;
  weeklyTotalAvailable: number;
  warnings: string[];
}

export interface CreditItemView extends ParsedCreditItem {
  primaryUsedAmount?: number | null;
  secondaryUsedAmount?: number | null;
  importedUsedAmount?: number | null;
  usageSource?: "credit" | "financing" | "bond_investors";
  linkedClientCount?: number | null;
}

export interface CreditInstitutionView
  extends ParsedCreditInstitution {
  reportDate: string;
  updatedAt: string;
  lastChangedOn?: string;
  verified?: boolean;
  effectiveStatus?: import('./validity.ts').CreditEffectiveStatus;
  items: CreditItemView[];
  importedTotalUsed?: number | null;
  clients?: Array<{ id: string; name: string }>;
  utilization: number | null;
  availableAmount: number | null;
}

export interface CreditSummaryView {
  reportDate: string;
  institutionCount: number;
  approvedCount: number;
  totalLimit: number;
  totalUsed: number;
  totalAvailable: number;
  utilization: number;
  expiringWithin30Days: number;
}

export interface CreditWeeklySummaryView extends CreditSummaryView {
  addedInstitutionCount: number;
  expiredInstitutionCount: number;
}

export interface CreditAmountChange {
  institutionName: string;
  institutionType: string;
  kind: "added" | "removed" | "changed";
  previousAmount: number;
  currentAmount: number;
  deltaAmount: number;
  details: string[];
}

export const creditEventTypes = [
  "new",
  "renewal",
  "increase",
  "expiry",
  "revocation",
  "decrease",
  "amendment",
] as const;

export type CreditEventType = (typeof creditEventTypes)[number];

export const creditApplicationTypes = ["new", "renewal", "increase", "revocation", "maintenance"] as const;
export type CreditApplicationType = (typeof creditApplicationTypes)[number];

export interface CreditEventDetail {
  type: CreditItemType;
  limitAmount: number | null;
  details: string | null;
}

export interface CreditWeeklyNewsItem {
  reportDate: string;
  previousReportDate: string;
  institutionName: string;
  institutionType: string;
  eventType: CreditEventType;
  previousStatus: CreditStatus | null;
  currentStatus: CreditStatus | null;
  previousAmount: number;
  currentAmount: number;
  deltaAmount: number;
  previousEffectiveDate: string | null;
  currentEffectiveDate: string | null;
  previousExpiryDate: string | null;
  currentExpiryDate: string | null;
  creditDetails: CreditEventDetail[];
}

export interface CreditCalendarEvent {
  id: string;
  date: string;
  type: "expiry" | "added" | "usage";
  kind: "expiry" | "revoked" | "new" | "renewal" | "increase" | "decrease" | "amendment" | "usage";
  institutionName: string;
  label: string;
  itemType?: CreditItemType;
  usageComponent?: "primary" | "secondary";
  status: "upcoming" | "due" | "completed" | "revoked";
  statusLabel: string;
}

export interface CreditReportResponse {
  availableDates: string[];
  previousDate: string | null;
  summary: CreditSummaryView;
  previousSummary: CreditSummaryView | null;
  weeklySummary: CreditWeeklySummaryView;
  previousWeeklySummary: CreditWeeklySummaryView | null;
  institutions: CreditInstitutionView[];
  weeklyNews: CreditWeeklyNewsItem[];
  previousWeeklyNews?: CreditWeeklyNewsItem[];
  recentApprovals: CreditWeeklyNewsItem[];
  limitChanges: CreditAmountChange[];
  usageChanges: CreditAmountChange[];
  calendarEvents: CreditCalendarEvent[];
}

export interface CreditInstitutionUpdateResponse {
  institutionName:string;viewDate:string;calendarMonth:string;
  scope:'institution'|'context';data:import('./data.ts').CreditDataset;
}

export type CreditUsageType = 'bond_investment' | 'yield_certificate' | 'interbank_lending';
export interface CreditUsageDetail {
  reportDate: string; institutionName: string; type: CreditUsageType; linked: boolean;
  totalUsed: number | null; totalCount: number; offset: number;
  items: Array<{ id: string; name: string; clientName: string; amount: number; startDate: string | null; maturityDate: string | null }>;
}

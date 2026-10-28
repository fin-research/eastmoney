export interface Delivery {
  id: string; source: string; channel: string; status: string; subject: string; recipient: string;
  attempts: number; providerId: string | null; error: string | null; createdAt: number; updatedAt: number; nextAttemptAt: number;
}
export interface DeliveryList { items: Delivery[]; nextCursor: number | null; counts: { status: string; count: number }[] }
export interface DeliveryDetail extends Delivery {
  content: { text?: string; html?: string };
  history: { number: number; started_at: number; finished_at: number | null; status: string; provider_id: string | null; error: string | null }[];
  retries: {actor: string; created_at: number; previous_status: string}[];
}

export interface TestRecipient {id:string;name:string;email:string}
export interface TestSendResult {id:string;status:string;deliveries:number;skipped:{userId:string;channel:string;reason:string}[]}

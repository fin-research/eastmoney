import { MAX_LEDGER_BYTES } from "../bond-ledger/import-limits.ts";

/** One presigned-upload purpose. Permission is enforced per purpose, so a
 * unified tool can still gate each destination by the caller's real grants. */
export interface UploadPurpose {
  /** R2 bucket name on the S3-compatible endpoint, matching the Worker binding. */
  readonly bucketName: string;
  readonly prefix: string;
  readonly maxBytes: number;
  readonly extensions: readonly string[];
  readonly permission: string;
  readonly contentType: string;
}

export const UPLOAD_PURPOSES = {
  "bond-ledger": {
    bucketName: "eastmoney",
    prefix: "bond-ledger/imports/",
    maxBytes: MAX_LEDGER_BYTES,
    extensions: [".xlsx"],
    permission: "bond.ledger:import",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
} as const satisfies Record<string, UploadPurpose>;

export type UploadPurposeName = keyof typeof UPLOAD_PURPOSES;

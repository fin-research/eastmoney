import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/** userId comes only from authorizeRequest, never from a cookie/body/header. */
export function creditAgentName(userId: string): string {
  return "credit-public-user-v2-" + bytesToHex(sha256(new TextEncoder().encode(userId)));
}

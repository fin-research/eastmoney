const R2_REGION = "auto";
const R2_SERVICE = "s3";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

export interface R2PresignCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function hmac(key: string | ArrayBuffer, value: string): Promise<ArrayBuffer> {
  const keyBytes = typeof key === "string" ? new TextEncoder().encode(key) : new Uint8Array(key);
  const imported = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(value));
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Presign a create-only R2 PUT. */
export async function presignR2PutUrl(
  credentials: R2PresignCredentials,
  accountId: string,
  bucket: string,
  key: string,
  contentType: string,
  expiresInSeconds: number,
  now: Date = new Date(),
): Promise<{ url: string; expiresAt: string; requiredHeaders: Record<string, string> }> {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const credentialScope = `${dateStamp}/${R2_REGION}/${R2_SERVICE}/aws4_request`;
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${credentials.accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresInSeconds),
    "X-Amz-SignedHeaders": "content-type;host;if-none-match",
  };
  const canonicalQuery = Object.entries(query)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${percentEncode(name)}=${percentEncode(value)}`)
    .join("&");
  const canonicalUri = `/${[bucket, ...key.split("/")].map(percentEncode).join("/")}`;
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nif-none-match:*\n`;
  const signedHeaders = "content-type;host;if-none-match";
  const canonicalRequest = ["PUT", canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, UNSIGNED_PAYLOAD].join("\n");
  const hashedRequest = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalRequest)));
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, hashedRequest].join("\n");
  const dateKey = await hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const regionKey = await hmac(dateKey, R2_REGION);
  const serviceKey = await hmac(regionKey, R2_SERVICE);
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));
  const url = `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  return { url, expiresAt: new Date(now.getTime() + expiresInSeconds * 1000).toISOString(), requiredHeaders: { "Content-Type": contentType, "If-None-Match": "*" } };
}

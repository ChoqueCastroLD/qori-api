import { AwsClient } from "aws4fetch";

// Cloudflare R2 (S3-compatible) object storage. Credentials live in env only.
const ENDPOINT = process.env.R2_ENDPOINT ?? ""; // https://<acct>.r2.cloudflarestorage.com
const BUCKET = process.env.R2_BUCKET ?? "";
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID ?? "";
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY ?? "";
// Public base for serving objects (custom domain), no trailing slash.
const PUBLIC_BASE = (process.env.R2_PUBLIC_BASE_URL ?? "").replace(/\/$/, "");

export function storageConfigured(): boolean {
  return !!(ENDPOINT && BUCKET && ACCESS_KEY_ID && SECRET_ACCESS_KEY && PUBLIC_BASE);
}

const aws = new AwsClient({
  accessKeyId: ACCESS_KEY_ID,
  secretAccessKey: SECRET_ACCESS_KEY,
  region: "auto",
  service: "s3",
});

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

export const MAX_UPLOAD_BYTES = 6 * 1024 * 1024; // 6 MB

export function extForType(contentType: string): string | null {
  return EXT[contentType.toLowerCase()] ?? null;
}

/** Upload bytes to R2 under `key`, returning the public URL. Throws on failure. */
export async function uploadObject(key: string, bytes: ArrayBuffer | Uint8Array, contentType: string): Promise<string> {
  if (!storageConfigured()) throw new Error("storage_not_configured");
  const url = `${ENDPOINT}/${BUCKET}/${key}`;
  const res = await aws.fetch(url, {
    method: "PUT",
    body: bytes,
    headers: { "content-type": contentType, "cache-control": "public, max-age=31536000, immutable" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`r2_put_failed ${res.status} ${body.slice(0, 200)}`);
  }
  return `${PUBLIC_BASE}/${key}`;
}

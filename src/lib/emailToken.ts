import { hmacSha256Hex } from "../fair";

// Stateless email-verification token: `${userId}.${exp}.${sig}` where
// sig = HMAC(secret, `${userId}.${exp}`). No DB storage needed.
const SECRET = process.env.EMAIL_SECRET || process.env.ADMIN_TOKEN || "dev-email-secret";
const TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

export async function makeEmailToken(userId: string): Promise<string> {
  const exp = Date.now() + TTL_MS;
  const sig = await hmacSha256Hex(SECRET, `${userId}.${exp}`);
  return `${userId}.${exp}.${sig}`;
}

// --- Purpose-scoped tokens (e.g. password reset) ---
// Same stateless shape, but the signature binds the purpose so a verify-email
// token can never be replayed as a reset token (or vice versa). An optional
// `bind` mixes extra state into the signature (e.g. the current password hash)
// so the token self-invalidates when that state changes - a reset link becomes
// single-use without any DB storage.

export async function makeScopedToken(userId: string, purpose: string, ttlMs: number, bind = ""): Promise<string> {
  const exp = Date.now() + ttlMs;
  const sig = await hmacSha256Hex(SECRET, `${purpose}.${userId}.${exp}.${bind}`);
  return `${userId}.${exp}.${sig}`;
}

/** Returns the userId embedded in a token WITHOUT verifying it (to look up bind state). */
export function peekTokenUserId(token: string): string | null {
  const parts = token.split(".");
  return parts.length === 3 && parts[0] ? parts[0] : null;
}

export async function verifyScopedToken(token: string, purpose: string, bind = ""): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!userId || !Number.isFinite(exp) || exp < Date.now()) return null;
  const expected = await hmacSha256Hex(SECRET, `${purpose}.${userId}.${exp}.${bind}`);
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? userId : null;
}

export async function verifyEmailToken(token: string): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!userId || !Number.isFinite(exp) || exp < Date.now()) return null;
  const expected = await hmacSha256Hex(SECRET, `${userId}.${exp}`);
  // constant-time-ish compare
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? userId : null;
}

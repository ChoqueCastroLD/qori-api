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

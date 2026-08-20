import { db } from "../db";

const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS ?? 30);

// --- Passwords (Argon2id via Bun's built-in, no external dep) ---

export function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, { algorithm: "argon2id" });
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return Bun.password.verify(plain, hash);
}

// --- Opaque session tokens ---
// The raw token lives only in the user's cookie; we store its sha256 hash.

function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createSession(userId: string, meta?: { userAgent?: string; ip?: string }) {
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.session.create({
    data: { tokenHash, userId, expiresAt, userAgent: meta?.userAgent, ip: meta?.ip },
  });
  return { token, expiresAt };
}

/** Resolve the user for a raw session token, or null if invalid/expired. */
export async function userFromToken(token: string | undefined) {
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const session = await db.session.findUnique({ where: { tokenHash }, include: { user: true } });
  if (!session) return null;
  if (session.expiresAt < new Date()) {
    await db.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  return session.user;
}

export async function destroySession(token: string | undefined) {
  if (!token) return;
  const tokenHash = await sha256Hex(token);
  await db.session.deleteMany({ where: { tokenHash } });
}

// --- Referral codes ---

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars

function randomCode(len = 8): string {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

/** Generate a referral code guaranteed unique in the DB. */
export async function uniqueReferralCode(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const code = randomCode();
    const exists = await db.user.findUnique({ where: { referralCode: code } });
    if (!exists) return code;
  }
  throw new Error("could not generate a unique referral code");
}

export const SESSION_COOKIE = "qori_session";

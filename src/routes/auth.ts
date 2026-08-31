import { Elysia, t } from "elysia";
import { db } from "../db";
import {
  createSession,
  destroySession,
  hashPassword,
  sha256Hex,
  SESSION_COOKIE,
  uniqueReferralCode,
  userFromToken,
  verifyPassword,
} from "../lib/auth";
import type { User } from "@prisma/client";
import { sendEmail, verificationEmail, verificationCodeEmail, passwordResetEmail } from "../lib/email";
import { makeEmailToken, verifyEmailToken, makeScopedToken, verifyScopedToken, peekTokenUserId } from "../lib/emailToken";
import { isAllowedEmailDomain } from "../lib/emailDomains";

const codeHashFor = (code: string, email: string) => sha256Hex(`${code}:${email}`);

// Per-email cooldown for password-reset requests (in-memory, single instance).
const forgotCooldown = new Map<string, number>();

// Naive brute-force guard: max 10 failed logins per email per 15 minutes.
const loginFails = new Map<string, { count: number; first: number }>();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
function loginBlocked(email: string): boolean {
  const e = loginFails.get(email);
  if (!e) return false;
  if (Date.now() - e.first > LOGIN_WINDOW_MS) { loginFails.delete(email); return false; }
  return e.count >= 10;
}
function recordLoginFail(email: string) {
  const now = Date.now();
  const e = loginFails.get(email);
  if (!e || now - e.first > LOGIN_WINDOW_MS) loginFails.set(email, { count: 1, first: now });
  else e.count++;
  if (loginFails.size > 5000) {
    for (const [k, v] of loginFails) if (now - v.first > LOGIN_WINDOW_MS) loginFails.delete(k);
  }
}

/** Fire-and-forget verification email. */
async function sendVerification(user: { id: string; email: string }) {
  const token = await makeEmailToken(user.id);
  const link = `${WEB_ORIGIN}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  const { subject, html } = verificationEmail(link);
  await sendEmail({ to: user.email, subject, html });
}

const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS ?? 30);
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:4321";
const isProd = process.env.NODE_ENV === "production";

export function publicUser(u: User) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    nickname: u.nickname,
    username: u.username,
    usernameChangedAt: u.usernameChangedAt,
    avatarUrl: u.avatarUrl,
    country: u.country,
    role: u.role,
    balance: u.balance,
    referralCode: u.referralCode,
    emailVerified: !!u.emailVerified,
  };
}

function sessionCookieOpts(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  };
}

/**
 * Session plugin: resolves `user` (or null) from the session cookie and exposes
 * it globally. Named + deduped by Elysia, so `auth`, `me` and any other plugin
 * can `.use(withUser)` and share a single per-request resolution.
 */
export const withUser = new Elysia({ name: "with-user" }).derive(
  { as: "global" },
  async ({ cookie }) => {
    const token = cookie[SESSION_COOKIE]?.value as string | undefined;
    const user = await userFromToken(token);
    return { user };
  },
);

/**
 * Auth plugin. Exposes `user` to any route via `withUser`, plus the auth
 * endpoints (register/login/logout/me/google).
 */
export const auth = new Elysia({ name: "auth" })
  .use(withUser)

  // --- Step 1: request a verification code (pre-registration, no account yet) ---
  .post(
    "/auth/request-code",
    async ({ body, set }) => {
      const email = body.email.trim().toLowerCase();
      if (!isAllowedEmailDomain(email)) {
        set.status = 422;
        return { error: "email_domain_not_allowed" };
      }
      const existing = await db.user.findUnique({ where: { email } });
      if (existing) {
        set.status = 409;
        return { error: "email_taken" };
      }
      // Cooldown: avoid spamming codes (30s between sends per email).
      const prev = await db.emailVerification.findUnique({ where: { email } });
      if (prev && Date.now() - prev.updatedAt.getTime() < 30_000) {
        set.status = 429;
        return { error: "too_soon" };
      }
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const codeHash = await codeHashFor(code, email);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
      await db.emailVerification.upsert({
        where: { email },
        update: { codeHash, expiresAt, attempts: 0 },
        create: { email, codeHash, expiresAt },
      });
      const { subject, html } = verificationCodeEmail(code);
      const sent = await sendEmail({ to: email, subject, html });
      return { ok: true, sent };
    },
    { body: t.Object({ email: t.String({ format: "email" }) }) },
  )

  // --- Step 2: register (requires a valid code → account is verified on creation) ---
  .post(
    "/auth/register",
    async ({ body, cookie, set, request }) => {
      const email = body.email.trim().toLowerCase();
      if (!isAllowedEmailDomain(email)) {
        set.status = 422;
        return { error: "email_domain_not_allowed" };
      }
      const existing = await db.user.findUnique({ where: { email } });
      if (existing) {
        set.status = 409;
        return { error: "email_taken" };
      }

      // Verify the emailed code (pre-registration gate).
      const rec = await db.emailVerification.findUnique({ where: { email } });
      if (!rec || rec.expiresAt < new Date()) {
        set.status = 422;
        return { error: "code_expired" };
      }
      if (rec.attempts >= 5) {
        set.status = 429;
        return { error: "too_many_attempts" };
      }
      const codeOk = (await codeHashFor(body.code, email)) === rec.codeHash;
      if (!codeOk) {
        await db.emailVerification.update({ where: { email }, data: { attempts: { increment: 1 } } });
        set.status = 422;
        return { error: "invalid_code" };
      }

      // Resolve referrer from an optional referral code.
      let referredById: string | null = null;
      if (body.ref) {
        // Codes are generated uppercase; accept them case-insensitively.
        const referrer = await db.user.findUnique({ where: { referralCode: body.ref.trim().toUpperCase() } });
        if (referrer) referredById = referrer.id;
      }

      const user = await db.user.create({
        data: {
          email,
          emailVerified: new Date(), // verified via the emailed code
          passwordHash: await hashPassword(body.password),
          name: body.name,
          nickname: body.nickname ?? body.name ?? null,
          country: body.country,
          referralCode: await uniqueReferralCode(),
          referredById,
        },
      });
      await db.emailVerification.delete({ where: { email } }).catch(() => {});

      const { token, expiresAt } = await createSession(user.id, {
        userAgent: request.headers.get("user-agent") ?? undefined,
      });
      cookie[SESSION_COOKIE].set({ value: token, ...sessionCookieOpts(expiresAt) });
      return { user: publicUser(user) };
    },
    {
      body: t.Object({
        email: t.String({ format: "email" }),
        code: t.String({ minLength: 6, maxLength: 6 }),
        password: t.String({ minLength: 8, maxLength: 200 }),
        name: t.Optional(t.String({ maxLength: 100 })),
        nickname: t.Optional(t.String({ maxLength: 40 })),
        country: t.Optional(t.String({ minLength: 2, maxLength: 2 })),
        ref: t.Optional(t.String({ maxLength: 16 })),
      }),
    },
  )

  // --- Verify email (link from the verification email) ---
  .get("/auth/verify-email", async ({ query, set }) => {
    const userId = query.token ? await verifyEmailToken(query.token) : null;
    if (!userId) {
      set.status = 302; set.headers.location = `${WEB_ORIGIN}/correo-verificado?ok=0`;
      return;
    }
    await db.user.update({ where: { id: userId }, data: { emailVerified: new Date() } }).catch(() => {});
    set.status = 302; set.headers.location = `${WEB_ORIGIN}/correo-verificado?ok=1`;
  }, { query: t.Object({ token: t.Optional(t.String()) }) })

  // --- Resend verification email ---
  .post("/auth/resend-verification", async ({ user, set }: any) => {
    if (!user) { set.status = 401; return { error: "unauthenticated" }; }
    if (user.emailVerified) return { ok: true, already: true };
    await sendVerification(user).catch(() => {});
    return { ok: true };
  })

  // --- Login ---
  .post(
    "/auth/login",
    async ({ body, cookie, set, request }) => {
      const email = body.email.trim().toLowerCase();
      if (loginBlocked(email)) {
        set.status = 429;
        return { error: "too_many_attempts" };
      }
      const user = await db.user.findUnique({ where: { email } });
      if (!user || !user.passwordHash || !(await verifyPassword(body.password, user.passwordHash))) {
        recordLoginFail(email);
        set.status = 401;
        return { error: "invalid_credentials" };
      }
      loginFails.delete(email);
      const { token, expiresAt } = await createSession(user.id, {
        userAgent: request.headers.get("user-agent") ?? undefined,
      });
      cookie[SESSION_COOKIE].set({ value: token, ...sessionCookieOpts(expiresAt) });
      return { user: publicUser(user) };
    },
    {
      body: t.Object({
        email: t.String({ format: "email" }),
        password: t.String(),
      }),
    },
  )

  // --- Forgot password: email a reset link ---
  // Always responds ok (never reveals whether the email exists). 60s in-memory
  // cooldown per email against abuse.
  .post(
    "/auth/forgot-password",
    async ({ body, set }) => {
      const email = body.email.trim().toLowerCase();
      const now = Date.now();
      const last = forgotCooldown.get(email) ?? 0;
      if (now - last < 60_000) {
        set.status = 429;
        return { error: "too_soon" };
      }
      forgotCooldown.set(email, now);
      if (forgotCooldown.size > 5000) {
        for (const [k, v] of forgotCooldown) if (now - v > 10 * 60_000) forgotCooldown.delete(k);
      }
      const user = await db.user.findUnique({ where: { email } });
      if (user) {
        // Bound to the current password hash: once the password changes, every
        // outstanding reset link for this account stops working (single-use).
        const bind = await sha256Hex(user.passwordHash ?? "none");
        const token = await makeScopedToken(user.id, "pwreset", 30 * 60 * 1000, bind);
        const link = `${WEB_ORIGIN}/recuperar?token=${encodeURIComponent(token)}`;
        const { subject, html } = passwordResetEmail(link);
        void sendEmail({ to: user.email, subject, html }).catch(() => {});
      }
      return { ok: true };
    },
    { body: t.Object({ email: t.String({ format: "email" }) }) },
  )

  // --- Reset password with an emailed token ---
  // Sets the new password and revokes every existing session.
  .post(
    "/auth/reset-password",
    async ({ body, set }) => {
      const candidateId = peekTokenUserId(body.token);
      const user = candidateId ? await db.user.findUnique({ where: { id: candidateId } }) : null;
      if (!user) {
        set.status = 422;
        return { error: "invalid_token" };
      }
      // The signature is bound to the password hash at request time, so a link
      // that was already used (password changed) no longer verifies.
      const bind = await sha256Hex(user.passwordHash ?? "none");
      const userId = await verifyScopedToken(body.token, "pwreset", bind);
      if (!userId) {
        set.status = 422;
        return { error: "invalid_token" };
      }
      await db.user.update({
        where: { id: userId },
        data: { passwordHash: await hashPassword(body.password) },
      });
      await db.session.deleteMany({ where: { userId } }).catch(() => {});
      return { ok: true };
    },
    {
      body: t.Object({
        token: t.String({ maxLength: 300 }),
        password: t.String({ minLength: 8, maxLength: 200 }),
      }),
    },
  )

  // --- Logout ---
  .post("/auth/logout", async ({ cookie }) => {
    await destroySession(cookie[SESSION_COOKIE]?.value as string | undefined);
    cookie[SESSION_COOKIE].remove();
    return { ok: true };
  })

  // --- Current user --- (200 with user:null for anonymous, to avoid console noise)
  .get("/auth/me", async ({ user }) => {
    if (!user) return { user: null };
    const ticketCount = await db.ticket.count({ where: { ownerId: user.id } });
    return { user: { ...publicUser(user), ticketCount } };
  })

  // --- Google OAuth: start ---
  .get("/auth/google", ({ cookie, set }) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    if (!clientId || !redirectUri) {
      // Not configured yet - bounce back to the login page with a friendly note
      // instead of showing raw JSON.
      set.status = 302; set.headers.location = `${WEB_ORIGIN}/entrar?oauth=unavailable`;
      return;
    }
    const state = crypto.randomUUID();
    cookie["qori_oauth_state"].set({
      value: state,
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    set.status = 302; set.headers.location = url.toString();
  })

  // --- Google OAuth: callback ---
  .get(
    "/auth/google/callback",
    async ({ query, cookie, set, request }) => {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      const redirectUri = process.env.GOOGLE_REDIRECT_URI;
      if (!clientId || !clientSecret || !redirectUri) {
        set.status = 501;
        return { error: "google_oauth_not_configured" };
      }
      if (!query.code || !query.state || query.state !== cookie["qori_oauth_state"]?.value) {
        set.status = 400;
        return { error: "invalid_oauth_state" };
      }

      // Exchange the code for tokens.
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: query.code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });
      if (!tokenRes.ok) {
        set.status = 502;
        return { error: "google_token_exchange_failed" };
      }
      const tokens = (await tokenRes.json()) as { access_token: string };

      const infoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      });
      if (!infoRes.ok) {
        set.status = 502;
        return { error: "google_userinfo_failed" };
      }
      const profile = (await infoRes.json()) as {
        id: string;
        email: string;
        name?: string;
        picture?: string;
        verified_email?: boolean;
      };

      // Link to an existing account (by oauth link or email) or create one.
      const user = await db.$transaction(async (tx) => {
        const existingLink = await tx.oAuthAccount.findUnique({
          where: { provider_providerAccountId: { provider: "google", providerAccountId: profile.id } },
          include: { user: true },
        });
        if (existingLink) return existingLink.user;

        const email = profile.email.trim().toLowerCase();
        let u = await tx.user.findUnique({ where: { email } });
        if (!u) {
          u = await tx.user.create({
            data: {
              email,
              emailVerified: profile.verified_email ? new Date() : null,
              name: profile.name,
              nickname: profile.name,
              avatarUrl: profile.picture,
              referralCode: await uniqueReferralCode(),
            },
          });
        }
        await tx.oAuthAccount.create({
          data: { provider: "google", providerAccountId: profile.id, userId: u.id },
        });
        return u;
      });

      const { token, expiresAt } = await createSession(user.id, {
        userAgent: request.headers.get("user-agent") ?? undefined,
      });
      cookie[SESSION_COOKIE].set({ value: token, ...sessionCookieOpts(expiresAt) });
      cookie["qori_oauth_state"].remove();
      // Back to the web app, now logged in.
      set.status = 302; set.headers.location = WEB_ORIGIN;
    },
    { query: t.Object({ code: t.Optional(t.String()), state: t.Optional(t.String()) }) },
  );

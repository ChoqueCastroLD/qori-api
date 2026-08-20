import { Elysia, t } from "elysia";
import { db } from "../db";
import {
  createSession,
  destroySession,
  hashPassword,
  SESSION_COOKIE,
  uniqueReferralCode,
  userFromToken,
  verifyPassword,
} from "../lib/auth";
import type { User } from "@prisma/client";

const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS ?? 30);
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:4321";
const isProd = process.env.NODE_ENV === "production";

export function publicUser(u: User) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    nickname: u.nickname,
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

  // --- Register with email + password ---
  .post(
    "/auth/register",
    async ({ body, cookie, set, request }) => {
      const email = body.email.trim().toLowerCase();
      const existing = await db.user.findUnique({ where: { email } });
      if (existing) {
        set.status = 409;
        return { error: "email_taken" };
      }

      // Resolve referrer from an optional referral code.
      let referredById: string | null = null;
      if (body.ref) {
        const referrer = await db.user.findUnique({ where: { referralCode: body.ref } });
        if (referrer) referredById = referrer.id;
      }

      const user = await db.user.create({
        data: {
          email,
          passwordHash: await hashPassword(body.password),
          name: body.name,
          nickname: body.nickname ?? body.name ?? null,
          country: body.country,
          referralCode: await uniqueReferralCode(),
          referredById,
        },
      });

      const { token, expiresAt } = await createSession(user.id, {
        userAgent: request.headers.get("user-agent") ?? undefined,
      });
      cookie[SESSION_COOKIE].set({ value: token, ...sessionCookieOpts(expiresAt) });
      return { user: publicUser(user) };
    },
    {
      body: t.Object({
        email: t.String({ format: "email" }),
        password: t.String({ minLength: 8, maxLength: 200 }),
        name: t.Optional(t.String({ maxLength: 100 })),
        nickname: t.Optional(t.String({ maxLength: 40 })),
        country: t.Optional(t.String({ minLength: 2, maxLength: 2 })),
        ref: t.Optional(t.String({ maxLength: 16 })),
      }),
    },
  )

  // --- Login ---
  .post(
    "/auth/login",
    async ({ body, cookie, set, request }) => {
      const email = body.email.trim().toLowerCase();
      const user = await db.user.findUnique({ where: { email } });
      if (!user || !user.passwordHash || !(await verifyPassword(body.password, user.passwordHash))) {
        set.status = 401;
        return { error: "invalid_credentials" };
      }
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

  // --- Logout ---
  .post("/auth/logout", async ({ cookie }) => {
    await destroySession(cookie[SESSION_COOKIE]?.value as string | undefined);
    cookie[SESSION_COOKIE].remove();
    return { ok: true };
  })

  // --- Current user ---
  .get("/auth/me", ({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: "unauthenticated" };
    }
    return { user: publicUser(user) };
  })

  // --- Google OAuth: start ---
  .get("/auth/google", ({ cookie, set }) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    if (!clientId || !redirectUri) {
      set.status = 501;
      return { error: "google_oauth_not_configured" };
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
    set.redirect = url.toString();
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
      set.redirect = WEB_ORIGIN;
    },
    { query: t.Object({ code: t.Optional(t.String()), state: t.Optional(t.String()) }) },
  );

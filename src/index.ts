import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { hmacSha256Hex, sha256Hex, verifyDraw } from "./fair";
import { generateShow, generateShowV2, type GameType } from "./show";
import { db } from "./db";
import { getRafflesCache, setRafflesCache } from "./lib/rafflesCache";
import { suertudoSet } from "./lib/suertudo";
import { addSocket, removeSocket } from "./lib/liveRaffles";
import { auth } from "./routes/auth";
import { me } from "./routes/me";
import { admin } from "./routes/admin";
import { chat } from "./routes/chat";
import { mp } from "./routes/mp";
import { paypal } from "./routes/paypal";
import { nowpayments } from "./routes/nowpayments";
import { startScheduler } from "./scheduler";
import { getRates } from "./lib/fx";

const PORT = Number(process.env.PORT ?? 3000);
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:4321";

/** Public-safe view of a raffle: never leaks an unrevealed serverSeed. */
function publicRaffle(r: any) {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    description: r.description,
    images: r.images,
    prizeValue: r.prizeValue,
    ticketPrice: r.ticketPrice,
    totalTickets: r.totalTickets,
    minTickets: r.minTickets,
    maxTicketsPerUser: r.maxTicketsPerUser,
    winnersCount: r.winnersCount,
    paidOnly: r.paidOnly ?? false,
    games: r.games,
    finale: r.finale,
    status: r.status,
    legacy: r.legacy,
    opensAt: r.opensAt,
    closesAt: r.closesAt,
    drawnAt: r.drawnAt,
    extensionCount: r.extensionCount,
    extensions: r.extensions ?? [],
    blocked: r.blocked ?? false,
    blockReason: r.blockReason ?? null,
    ticketsSold: r._count?.tickets ?? undefined,
    fairness: {
      commitment: r.commitment,
      entropySource: r.entropySource,
      serverSeed: r.status === "DRAWN" ? r.serverSeed : null,
      drandRound: r.drandRound != null ? r.drandRound.toString() : null,
      drandValue: r.drandValue ?? null,
      ticketsRoot: r.ticketsRoot ?? null,
      drawDigest: r.drawDigest ?? null,
      showVersion: r.showVersion ?? 1,
    },
  };
}

// Public featured/nearest-open raffle for banners/widgets on any origin.
async function publicFeatured(set: any) {
  set.headers["cache-control"] = "public, max-age=60, s-maxage=60";
  set.headers["access-control-allow-origin"] = "*";
  const now = new Date();
  const r = await db.raffle.findFirst({
    where: { status: "OPEN", blocked: false, legacy: false, closesAt: { not: null } },
    orderBy: { closesAt: "asc" },
    include: { _count: { select: { tickets: true } } },
  });
  if (!r) return { serverNow: now.toISOString(), raffle: null };
  return {
    serverNow: now.toISOString(),
    raffle: {
      id: r.id,
      slug: r.slug,
      url: `${WEB_ORIGIN}/sorteos/${r.slug}`,
      status: "open",
      prize: {
        name: r.title,
        imageUrl: r.images?.[0] ?? null,
        valueAmount: r.prizeValue / 100, // cents -> USD
        currency: "USD",
      },
      endsAt: r.closesAt ? r.closesAt.toISOString() : null,
      drawTimezone: "America/Lima",
      ticketPriceAmount: r.ticketPrice / 10, // lingotes -> USD (10 lingotes = 1 USD)
      minTickets: r.minTickets,
      maxTickets: r.totalTickets,
      soldTickets: r._count?.tickets ?? 0,
      cashAlternative: true,
      sameDayDelivery: true,
      provablyFair: !r.legacy,
      minAge: 18,
    },
  };
}

const app = new Elysia({ prefix: "/api" })
  .use(cors({ origin: WEB_ORIGIN, credentials: true }))
  .use(auth)
  .use(me)
  .use(admin)
  .use(chat)
  .use(mp)
  .use(paypal)
  .use(nowpayments)
  .get("/health", () => ({ ok: true, service: "qori-api" }))

  // WebSocket: live ticket counts. Clients update any [data-live-sold="<slug>"]
  // element when anyone buys. (Own path to avoid the /raffles/:slug collision;
  // SSE was buffered by the proxy chain.)
  .ws("/live", {
    open(ws) { addSocket(ws); },
    close(ws) { removeSocket(ws); },
  })

  // Live USD exchange rates (indicative display only).
  .get("/fx", () => getRates())

  // --- Public raffle browsing ---
  // Short in-memory cache: this list feeds home/sorteos/ganadores/recargar SSR,
  // so a few seconds of staleness on ticket counts is fine and cuts TTFB.
  // Public, cacheable (CDN), CORS:* featured/nearest open raffle. Raw values
  // (amounts + UTC dates); the client formats. 200 with raffle:null when none.
  .get("/public/v1/raffles/featured", ({ set }) => publicFeatured(set))
  .get("/public/raffles/featured", ({ set }) => publicFeatured(set))

  // Top Suertudos: users who bought lingotes with real money, ranked by their
  // current lingote balance. Powers the landing leaderboard.
  .get("/suertudos/top", async ({ set }) => {
    set.headers["cache-control"] = "public, max-age=60, s-maxage=60";
    const paid = await db.topUp.findMany({ where: { status: "PAID" }, distinct: ["userId"], select: { userId: true } });
    const ids = paid.map((p) => p.userId);
    if (ids.length === 0) return { suertudos: [] };
    const top = await db.user.findMany({
      where: { id: { in: ids } },
      orderBy: { balance: "desc" },
      take: 10,
      select: { username: true, nickname: true, avatarUrl: true, balance: true },
    });
    return { suertudos: top.map((u, i) => ({ rank: i + 1, username: u.username, nickname: u.nickname, avatarUrl: u.avatarUrl, lingotes: u.balance })) };
  })

  // Public referral leaderboard: users AND affiliate brands, most referrals
  // first, only those with >= 1 referral.
  .get("/referrals/top", async ({ set }) => {
    set.headers["cache-control"] = "public, max-age=60, s-maxage=60";
    const [userRefs, affRefs] = await Promise.all([
      db.user.groupBy({ by: ["referredById"], where: { referredById: { not: null } }, _count: { _all: true } }),
      db.user.groupBy({ by: ["affiliateId"], where: { affiliateId: { not: null } }, _count: { _all: true } }),
    ]);
    const [users, affs] = await Promise.all([
      db.user.findMany({ where: { id: { in: userRefs.map((r) => r.referredById!) } }, select: { id: true, username: true, nickname: true, avatarUrl: true } }),
      db.affiliate.findMany({ where: { id: { in: affRefs.map((r) => r.affiliateId!) } }, select: { id: true, code: true, name: true } }),
    ]);
    const uMap = new Map(users.map((u) => [u.id, u]));
    const aMap = new Map(affs.map((a) => [a.id, a]));
    const entries = [
      ...userRefs.map((r) => { const u = uMap.get(r.referredById!); return { type: "user" as const, count: r._count._all, username: u?.username ?? null, nickname: u?.nickname ?? null, avatarUrl: u?.avatarUrl ?? null, code: null as string | null, name: null as string | null }; }),
      ...affRefs.map((r) => { const a = aMap.get(r.affiliateId!); return { type: "affiliate" as const, count: r._count._all, username: null, nickname: null, avatarUrl: null, code: a?.code ?? null, name: a?.name ?? null }; }),
    ].filter((e) => e.count >= 1).sort((a, b) => b.count - a.count).slice(0, 50).map((e, i) => ({ rank: i + 1, ...e }));
    return { top: entries };
  })

  // Look up a referral code (user or affiliate): how many it referred + who.
  .get("/referrals/lookup", async ({ query }) => {
    const raw = (query.code ?? "").trim();
    if (!raw) return { found: false };
    const listOf = (where: any) => db.user.findMany({ where, select: { username: true, nickname: true, avatarUrl: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 300 });
    const aff = await db.affiliate.findUnique({ where: { code: raw.toLowerCase() } });
    if (aff) {
      const referred = await listOf({ affiliateId: aff.id });
      return { found: true, type: "affiliate", owner: { name: aff.name, code: aff.code, avatarUrl: null, username: null }, count: referred.length, referred };
    }
    const u = await db.user.findUnique({ where: { referralCode: raw.toUpperCase() }, select: { id: true, username: true, nickname: true, avatarUrl: true } });
    if (u) {
      const referred = await listOf({ referredById: u.id });
      return { found: true, type: "user", owner: { name: u.nickname, username: u.username, avatarUrl: u.avatarUrl, code: raw.toUpperCase() }, count: referred.length, referred };
    }
    return { found: false };
  }, { query: t.Object({ code: t.Optional(t.String()) }) })

  .get("/raffles", async ({ set }) => {
    const cached = getRafflesCache();
    if (cached) {
      set.headers["cache-control"] = "public, max-age=8";
      return cached;
    }
    const raffles = await db.raffle.findMany({
      // Blocked raffles stay visible (marked "no disponible"); they just can't
      // sell tickets and are skipped by the scheduler.
      where: { status: { in: ["OPEN", "CLOSED", "DRAWING", "DRAWN"] } },
      orderBy: [{ status: "asc" }, { closesAt: "asc" }, { createdAt: "desc" }],
      include: {
        _count: { select: { tickets: true } },
        winners: { include: { ticket: true, user: true }, orderBy: { position: "asc" } },
      },
    });
    const data = raffles.map((r) => ({
      ...publicRaffle(r),
      winners: r.winners.map((w) => ({
        position: w.position,
        ticketNumber: w.ticket.number,
        nickname: w.user?.nickname ?? w.name ?? null,
        avatarUrl: w.user?.avatarUrl ?? null,
      })),
    }));
    setRafflesCache(data);
    set.headers["cache-control"] = "public, max-age=8";
    return data;
  })

  .get("/raffles/:slug", async ({ params, set }) => {
    const raffle = await db.raffle.findUnique({
      where: { slug: params.slug },
      include: {
        _count: { select: { tickets: true } },
        winners: { include: { ticket: true, user: true }, orderBy: { position: "asc" } },
        show: true,
      },
    });
    if (!raffle || raffle.status === "DRAFT") {
      set.status = 404;
      return { error: "not_found" };
    }
    // Live-show window: the animation plays from startsAt to startsAt+duration.
    // Same timing as the client (STEP_MS 1050 per elimination, GAP_MS 2200
    // between stages - MUST match ShowPlayer.tsx). Lets the page route people
    // into the live show and avoid spoilers.
    let show: { startsAt: string; endsAt: string } | null = null;
    if (raffle.show?.startsAt && raffle.show.stages) {
      const stages = (raffle.show.stages as any)?.stages ?? (raffle.show.stages as any) ?? [];
      // v2 games are self-timed (own choreography), so the exact end isn't known
      // here; use a generous window (the show self-terminates into the final
      // screen). v1 uses the step-based estimate.
      const dur = raffle.showVersion === 2
        ? 8 * 60 * 1000
        : Array.isArray(stages)
          ? stages.reduce((acc: number, s: any, i: number) => acc + (s.eliminated?.length ?? 0) * 1050 + (i < stages.length - 1 ? 2200 : 0), 0)
          : 0;
      const startsAt = new Date(raffle.show.startsAt).getTime();
      show = { startsAt: raffle.show.startsAt.toISOString(), endsAt: new Date(startsAt + dur + 2000).toISOString() };
    }
    const luckyWinners = await suertudoSet(raffle.winners.map((w) => w.user?.id));
    return {
      ...publicRaffle(raffle),
      show,
      winners: raffle.winners.map((w) => ({
        position: w.position,
        ticketNumber: w.ticket.number,
        nickname: w.user?.nickname ?? w.name ?? null,
        avatarUrl: w.user?.avatarUrl ?? null,
        username: w.user?.username ?? null,
        suertudo: w.user?.id ? luckyWinners.has(w.user.id) : false,
      })),
    };
  })

  // Public participants: who's in, with their ticket count (no money). Shown on
  // the raffle page for transparency; links to /u/:username.
  .get("/raffles/:slug/participants", async ({ params, set }) => {
    const raffle = await db.raffle.findUnique({ where: { slug: params.slug }, select: { id: true, status: true, ticketPrice: true } });
    if (!raffle) { set.status = 404; return { error: "not_found" }; }
    const tickets = await db.ticket.findMany({
      where: { raffleId: raffle.id, ownerId: { not: null } },
      select: { ownerId: true, owner: { select: { username: true, nickname: true, avatarUrl: true } } },
    });
    const byUser = new Map<string, { userId: string; username: string | null; nickname: string | null; avatarUrl: string | null; tickets: number }>();
    for (const t of tickets) {
      let e = byUser.get(t.ownerId!);
      if (!e) { e = { userId: t.ownerId!, username: t.owner?.username ?? null, nickname: t.owner?.nickname ?? null, avatarUrl: t.owner?.avatarUrl ?? null, tickets: 0 }; byUser.set(t.ownerId!, e); }
      e.tickets++;
    }
    const lucky = await suertudoSet([...byUser.keys()]);
    for (const e of byUser.values()) (e as any).suertudo = lucky.has(e.userId);
    // Paid raffles hide HOW MANY each person holds until the draw starts: you see
    // WHO is in, not how many (so nobody reads others' odds). Free raffles keep
    // counts; once DRAWN everything is revealed in the show.
    const hideCounts = raffle.ticketPrice > 0 && raffle.status !== "DRAWN" && raffle.status !== "DRAWING";
    const participants = hideCounts
      ? [...byUser.values()].sort((a, b) => (a.nickname ?? a.username ?? "").localeCompare(b.nickname ?? b.username ?? "")).map(({ userId, tickets, ...rest }) => ({ ...rest, tickets: null as number | null }))
      : [...byUser.values()].sort((a, b) => b.tickets - a.tickets).map(({ userId, ...e }) => ({ ...e, tickets: e.tickets as number | null }));
    return { count: byUser.size, totalTickets: tickets.length, hideCounts, participants };
  })

  // The generated live show + canonical participants (for animation + replay).
  .get("/raffles/:slug/show", async ({ params, set }) => {
    const raffle = await db.raffle.findUnique({
      where: { slug: params.slug },
      include: { show: true },
    });
    if (!raffle || !raffle.show) {
      set.status = 404;
      return { error: "no_show" };
    }
    const tickets = await db.ticket.findMany({
      where: { raffleId: raffle.id },
      orderBy: { number: "asc" },
      include: { owner: { select: { nickname: true, avatarUrl: true, username: true } } },
    });
    const participants = tickets.map((t) => ({
      number: t.number,
      comment: t.comment,
      nickname: t.owner?.nickname ?? null,
      avatarUrl: t.owner?.avatarUrl ?? null,
      username: t.owner?.username ?? null,
      boughtAt: t.createdAt,
    }));
    return {
      raffle: { slug: raffle.slug, title: raffle.title, winnersCount: raffle.winnersCount, ticketPrice: raffle.ticketPrice },
      show: raffle.show.stages,
      participants,
      startsAt: raffle.show.startsAt,
      fairness: publicRaffle({ ...raffle, _count: { tickets: tickets.length } }).fairness,
    };
  })

  // --- Provably-fair verification (winner only) ---
  .post(
    "/verify",
    ({ body }) => verifyDraw(body),
    {
      body: t.Object({
        serverSeed: t.String(),
        commitment: t.String(),
        publicEntropy: t.String(),
        // Bounded: this recomputes work proportional to ticketCount, so an
        // unbounded value would let anyone burn server CPU.
        ticketCount: t.Integer({ minimum: 1, maximum: 100_000 }),
        claimedWinnerIndex: t.Integer({ minimum: 0 }),
      }),
    },
  )

  // --- Full-show verification: recompute winners + stages from public values ---
  .post(
    "/verify-show",
    async ({ body }) => {
      const commitmentOk = (await sha256Hex(body.serverSeed)) === body.commitment;
      const digest = await hmacSha256Hex(body.serverSeed, body.publicEntropy);
      const opts = {
        digest,
        ticketCount: body.ticketCount,
        winnersCount: body.winnersCount,
        games: body.games as GameType[],
        finale: (body.finale as GameType) ?? null,
      };
      // Use the SAME algorithm version the raffle was drawn with, so historical
      // draws always re-verify against the exact show they produced.
      const show = body.showVersion === 2 ? generateShowV2(opts) : generateShow(opts);
      return {
        ok: commitmentOk,
        commitmentOk,
        digest,
        ticketCount: body.ticketCount,
        winnersCount: body.winnersCount,
        // Canonical 0-based indices; the client maps them to real ticket numbers
        // via the participant list (numbers are random, not index+1).
        winners: show.winners,
        stages: show.stages,
      };
    },
    {
      body: t.Object({
        serverSeed: t.String(),
        commitment: t.String(),
        publicEntropy: t.String(),
        // Bounded for the same reason as /verify: work grows with ticketCount.
        ticketCount: t.Integer({ minimum: 1, maximum: 100_000 }),
        winnersCount: t.Integer({ minimum: 1, maximum: 100 }),
        games: t.Array(t.String(), { maxItems: 20 }),
        finale: t.Optional(t.String()),
        showVersion: t.Optional(t.Integer()),
      }),
    },
  )
  .listen(PORT);

console.log(`🎟️  qori-api on http://localhost:${PORT}`);
startScheduler();

export type App = typeof app;

import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { hmacSha256Hex, sha256Hex, verifyDraw } from "./fair";
import { generateShow, type GameType } from "./show";
import { db } from "./db";
import { getRafflesCache, setRafflesCache } from "./lib/rafflesCache";
import { subscribeRaffles } from "./lib/liveRaffles";
import { auth } from "./routes/auth";
import { me } from "./routes/me";
import { admin } from "./routes/admin";
import { chat } from "./routes/chat";
import { mp } from "./routes/mp";
import { paypal } from "./routes/paypal";
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
  .get("/health", () => ({ ok: true, service: "qori-api" }))

  // Live USD exchange rates (indicative display only).
  .get("/fx", () => getRates())

  // --- Public raffle browsing ---
  // Short in-memory cache: this list feeds home/sorteos/ganadores/recargar SSR,
  // so a few seconds of staleness on ticket counts is fine and cuts TTFB.
  .get("/raffles", async ({ set }) => {
    const cached = getRafflesCache();
    if (cached) {
      set.headers["cache-control"] = "public, max-age=8";
      return cached;
    }
    const raffles = await db.raffle.findMany({
      where: { status: { in: ["OPEN", "CLOSED", "DRAWING", "DRAWN"] }, blocked: false },
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

  // Server-Sent Events: live ticket counts for every raffle (one stream/client).
  // Clients update any [data-live-sold="<slug>"] element on the page.
  .get("/raffles/live", () => {
    let unsub = () => {};
    let hb: ReturnType<typeof setInterval>;
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const send = (s: string) => { try { controller.enqueue(enc.encode(s)); } catch {} };
        send(": ok\n\n");
        unsub = subscribeRaffles((p) => send(`data: ${p}\n\n`));
        hb = setInterval(() => send(": hb\n\n"), 20000);
      },
      cancel() { clearInterval(hb); unsub(); },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
        connection: "keep-alive",
      },
    });
  })

  .get("/raffles/:slug", async ({ params, set }) => {
    const raffle = await db.raffle.findUnique({
      where: { slug: params.slug },
      include: {
        _count: { select: { tickets: true } },
        winners: { include: { ticket: true, user: true }, orderBy: { position: "asc" } },
      },
    });
    if (!raffle || raffle.status === "DRAFT") {
      set.status = 404;
      return { error: "not_found" };
    }
    return {
      ...publicRaffle(raffle),
      winners: raffle.winners.map((w) => ({
        position: w.position,
        ticketNumber: w.ticket.number,
        nickname: w.user?.nickname ?? w.name ?? null,
        avatarUrl: w.user?.avatarUrl ?? null,
      })),
    };
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
      include: { owner: { select: { nickname: true, avatarUrl: true } } },
    });
    const participants = tickets.map((t) => ({
      number: t.number,
      comment: t.comment,
      nickname: t.owner?.nickname ?? null,
      avatarUrl: t.owner?.avatarUrl ?? null,
      boughtAt: t.createdAt,
    }));
    return {
      raffle: { slug: raffle.slug, title: raffle.title, winnersCount: raffle.winnersCount },
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
        ticketCount: t.Integer({ minimum: 1 }),
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
      const show = generateShow({
        digest,
        ticketCount: body.ticketCount,
        winnersCount: body.winnersCount,
        games: body.games as GameType[],
        finale: (body.finale as GameType) ?? null,
      });
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
        ticketCount: t.Integer({ minimum: 1 }),
        winnersCount: t.Integer({ minimum: 1 }),
        games: t.Array(t.String()),
        finale: t.Optional(t.String()),
      }),
    },
  )
  .listen(PORT);

console.log(`🎟️  qori-api on http://localhost:${PORT}`);
startScheduler();

export type App = typeof app;

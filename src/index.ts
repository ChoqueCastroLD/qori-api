import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { computeWinner, createCommitment, verifyDraw } from "./fair";
import { db } from "./db";
import { auth } from "./routes/auth";

const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
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
    opensAt: r.opensAt,
    closesAt: r.closesAt,
    drawnAt: r.drawnAt,
    extensionCount: r.extensionCount,
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

// All backend routes live under /api (Coolify routes qori.cc/api → this app).
const app = new Elysia({ prefix: "/api" })
  .use(cors({ origin: WEB_ORIGIN, credentials: true }))
  .use(auth)
  .get("/health", () => ({ ok: true, service: "qori-api" }))

  // --- Public raffle browsing ---
  .get("/raffles", async () => {
    const raffles = await db.raffle.findMany({
      where: { status: { in: ["OPEN", "CLOSED", "DRAWING", "DRAWN"] } },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { tickets: true } } },
    });
    return raffles.map(publicRaffle);
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
        nickname: w.user?.nickname ?? null,
        avatarUrl: w.user?.avatarUrl ?? null,
      })),
    };
  })

  // --- Public provably-fair verification ---
  .post(
    "/verify",
    async ({ body }) => verifyDraw(body),
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

  // --- Admin (bearer token; real admin UI comes later) ---
  .guard(
    {
      beforeHandle({ headers, set }) {
        if (!ADMIN_TOKEN || headers["authorization"] !== `Bearer ${ADMIN_TOKEN}`) {
          set.status = 401;
          return { error: "unauthorized" };
        }
      },
    },
    (admin) =>
      admin
        .post(
          "/admin/raffles",
          async ({ body }) => {
            const { serverSeed, commitment } = await createCommitment();
            const raffle = await db.raffle.create({
              data: {
                slug: body.slug,
                title: body.title,
                description: body.description,
                images: body.images ?? [],
                prizeValue: body.prizeValue,
                ticketPrice: body.ticketPrice,
                totalTickets: body.totalTickets,
                minTickets: body.minTickets ?? 1,
                maxTicketsPerUser: body.maxTicketsPerUser ?? null,
                winnersCount: body.winnersCount ?? 1,
                games: (body.games ?? []) as any,
                finale: (body.finale ?? null) as any,
                entropySource: body.entropySource ?? "drand round at draw time",
                commitment,
                serverSeed,
                status: "OPEN",
                opensAt: new Date(),
                closesAt: body.closesAt ? new Date(body.closesAt) : null,
              },
            });
            return { id: raffle.id, slug: raffle.slug, commitment };
          },
          {
            body: t.Object({
              slug: t.String(),
              title: t.String(),
              description: t.String(),
              images: t.Optional(t.Array(t.String())),
              prizeValue: t.Integer(),
              ticketPrice: t.Integer({ minimum: 0 }),
              totalTickets: t.Integer({ minimum: 1 }),
              minTickets: t.Optional(t.Integer({ minimum: 1 })),
              maxTicketsPerUser: t.Optional(t.Integer({ minimum: 1 })),
              winnersCount: t.Optional(t.Integer({ minimum: 1 })),
              games: t.Optional(t.Array(t.String())),
              finale: t.Optional(t.String()),
              entropySource: t.Optional(t.String()),
              closesAt: t.Optional(t.String()),
            }),
          },
        )

        // Minimal draw (winner computation). Full gamified show comes in M4.
        .post(
          "/admin/raffles/:id/draw",
          async ({ params, body, set }) => {
            const raffle = await db.raffle.findUnique({ where: { id: params.id } });
            if (!raffle) {
              set.status = 404;
              return { error: "not_found" };
            }
            if (raffle.status === "DRAWN") {
              set.status = 409;
              return { error: "already_drawn" };
            }
            const ticketCount = await db.ticket.count({ where: { raffleId: raffle.id } });
            if (ticketCount < raffle.minTickets) {
              set.status = 422;
              return { error: "below_min_tickets", ticketCount, minTickets: raffle.minTickets };
            }

            const { winnerIndex, winnerNumber, digest } = await computeWinner({
              serverSeed: raffle.serverSeed!,
              publicEntropy: body.publicEntropy,
              ticketCount,
            });
            const winnerTicket = await db.ticket.findFirst({
              where: { raffleId: raffle.id },
              orderBy: { number: "asc" },
              skip: winnerIndex,
            });

            await db.$transaction([
              db.raffle.update({
                where: { id: raffle.id },
                data: {
                  status: "DRAWN",
                  drandValue: body.publicEntropy,
                  drawDigest: digest,
                  drawnAt: new Date(),
                },
              }),
              db.winner.create({
                data: {
                  raffleId: raffle.id,
                  ticketId: winnerTicket!.id,
                  userId: winnerTicket!.ownerId,
                  position: 1,
                },
              }),
            ]);

            return { winnerNumber, winnerTicketId: winnerTicket!.id, digest };
          },
          { body: t.Object({ publicEntropy: t.String() }) },
        ),
  )
  .listen(PORT);

console.log(`🎟️  qori-api on http://localhost:${PORT}`);

export type App = typeof app;

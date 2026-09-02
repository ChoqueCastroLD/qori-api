import { Elysia, t } from "elysia";
import { db } from "../db";
import { withUser } from "./auth";
import { suertudoSet, isSuertudo } from "../lib/suertudo";

const CHAT_GRACE_MS = 5 * 60 * 1000; // chat stays open 5 min after the draw

// Light anti-spam: minimum gap between messages per user (in-memory; single
// backend instance). Old entries are pruned opportunistically.
const CHAT_COOLDOWN_MS = 2000;
const lastMessageAt = new Map<string, number>();
function tooFast(userId: string): boolean {
  const now = Date.now();
  const last = lastMessageAt.get(userId) ?? 0;
  if (now - last < CHAT_COOLDOWN_MS) return true;
  lastMessageAt.set(userId, now);
  if (lastMessageAt.size > 5000) {
    for (const [k, v] of lastMessageAt) if (now - v > 60_000) lastMessageAt.delete(k);
  }
  return false;
}

export const chat = new Elysia({ name: "chat" })
  .use(withUser)
  // List recent messages (optionally only those after a timestamp, for polling).
  .get(
    "/raffles/:slug/chat",
    async ({ params, query }) => {
      const raffle = await db.raffle.findUnique({ where: { slug: params.slug }, select: { id: true, status: true, drawnAt: true } });
      if (!raffle) return { messages: [], closesAt: null, closed: false };
      const after = query.after ? new Date(query.after) : null;
      const messages = await db.chatMessage.findMany({
        where: { raffleId: raffle.id, ...(after ? { createdAt: { gt: after } } : {}) },
        orderBy: { createdAt: "desc" },
        take: 80,
      });
      // Chat closes 5 min after the raffle is drawn (then it's read-only history).
      const closesAt = raffle.status === "DRAWN" && raffle.drawnAt ? new Date(raffle.drawnAt.getTime() + CHAT_GRACE_MS) : null;
      const lucky = await suertudoSet(messages.map((m) => m.userId));
      const withSuertudo = messages.reverse().map((m) => ({ ...m, suertudo: lucky.has(m.userId) }));
      return { messages: withSuertudo, closesAt: closesAt ? closesAt.toISOString() : null, closed: !!closesAt && Date.now() > closesAt.getTime() };
    },
    { query: t.Object({ after: t.Optional(t.String()) }) },
  )
  // Post a message (auth required).
  .post(
    "/raffles/:slug/chat",
    async ({ params, body, user, set }: any) => {
      if (!user) {
        set.status = 401;
        return { error: "unauthenticated" };
      }
      if (user.canChat === false) {
        set.status = 403;
        return { error: "chat_disabled" };
      }
      const raffle = await db.raffle.findUnique({ where: { slug: params.slug }, select: { id: true, status: true, drawnAt: true } });
      if (!raffle) {
        set.status = 404;
        return { error: "not_found" };
      }
      if (raffle.status === "DRAWN" && raffle.drawnAt && Date.now() > raffle.drawnAt.getTime() + CHAT_GRACE_MS) {
        set.status = 403;
        return { error: "chat_closed" };
      }
      const text = body.text.trim().slice(0, 300);
      if (!text) {
        set.status = 422;
        return { error: "empty" };
      }
      if (tooFast(user.id)) {
        set.status = 429;
        return { error: "too_fast" };
      }
      // Snapshot the sender's ticket numbers in this raffle (for the live/dead
      // badge on their messages during the show).
      const myTickets = await db.ticket.findMany({ where: { raffleId: raffle.id, ownerId: user.id }, select: { number: true } });
      const msg = await db.chatMessage.create({
        data: {
          raffleId: raffle.id,
          userId: user.id,
          nickname: user.nickname || user.name || "Anónimo",
          avatarUrl: user.avatarUrl,
          text,
          ticketNumbers: myTickets.map((t) => t.number),
        },
      });
      return { message: { ...msg, suertudo: await isSuertudo(user.id) } };
    },
    { body: t.Object({ text: t.String({ minLength: 1, maxLength: 300 }) }) },
  );

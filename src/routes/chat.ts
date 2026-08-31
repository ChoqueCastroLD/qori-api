import { Elysia, t } from "elysia";
import { db } from "../db";
import { withUser } from "./auth";

const CHAT_GRACE_MS = 5 * 60 * 1000; // chat stays open 5 min after the draw

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
      return { messages: messages.reverse(), closesAt: closesAt ? closesAt.toISOString() : null, closed: !!closesAt && Date.now() > closesAt.getTime() };
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
      const msg = await db.chatMessage.create({
        data: {
          raffleId: raffle.id,
          userId: user.id,
          nickname: user.nickname || user.name || "Anónimo",
          avatarUrl: user.avatarUrl,
          text,
        },
      });
      return { message: msg };
    },
    { body: t.Object({ text: t.String({ minLength: 1, maxLength: 300 }) }) },
  );

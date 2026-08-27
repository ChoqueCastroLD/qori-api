import { Elysia, t } from "elysia";
import { db } from "../db";
import { withUser } from "./auth";

export const chat = new Elysia({ name: "chat" })
  .use(withUser)
  // List recent messages (optionally only those after a timestamp, for polling).
  .get(
    "/raffles/:slug/chat",
    async ({ params, query }) => {
      const raffle = await db.raffle.findUnique({ where: { slug: params.slug }, select: { id: true } });
      if (!raffle) return { messages: [] };
      const after = query.after ? new Date(query.after) : null;
      const messages = await db.chatMessage.findMany({
        where: { raffleId: raffle.id, ...(after ? { createdAt: { gt: after } } : {}) },
        orderBy: { createdAt: "desc" },
        take: 80,
      });
      return { messages: messages.reverse() };
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
      const raffle = await db.raffle.findUnique({ where: { slug: params.slug }, select: { id: true } });
      if (!raffle) {
        set.status = 404;
        return { error: "not_found" };
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

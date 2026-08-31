import { db } from "../db";
import { sendEmail, winnerEmail, resultsEmail, postponedEmail } from "./email";

/** Postponement notice to each participant, personalized with their ref code. */
export async function sendPostponed(raffleId: string, raffleTitle: string, slug: string, newDate: string) {
  const rows = await db.ticket.findMany({
    where: { raffleId, ownerId: { not: null } },
    distinct: ["ownerId"],
    select: { owner: { select: { email: true, referralCode: true } } },
  });
  for (const row of rows) {
    const u = row.owner;
    if (u?.email) await sendEmail({ to: u.email, ...postponedEmail(raffleTitle, slug, newDate, u.referralCode) }).catch(() => {});
  }
}

/** Distinct participants of a raffle: email + whether they won. */
export async function participants(raffleId: string): Promise<{ email: string; won: boolean }[]> {
  const tickets = await db.ticket.findMany({
    where: { raffleId, ownerId: { not: null } },
    select: { ownerId: true, owner: { select: { email: true } } },
  });
  const winners = await db.winner.findMany({ where: { raffleId }, select: { userId: true } });
  const winnerIds = new Set(winners.map((w) => w.userId));
  const byUser = new Map<string, { email: string; won: boolean }>();
  for (const t of tickets) {
    if (!t.ownerId || !t.owner?.email) continue;
    byUser.set(t.ownerId, { email: t.owner.email, won: winnerIds.has(t.ownerId) });
  }
  return [...byUser.values()];
}

/** Run `fn` once per (raffle, kind); returns false if already done. */
export async function notifyOnce(raffleId: string, kind: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await db.notificationLog.create({ data: { raffleId, kind } });
  } catch {
    return false; // unique violation → already sent
  }
  await fn().catch((e) => console.error(`notify ${kind} ${raffleId} failed`, e));
  return true;
}

/** Send the same email to a list of recipients (best-effort). */
export async function sendToAll(recipients: string[], mail: { subject: string; html: string }) {
  for (const to of recipients) {
    await sendEmail({ to, ...mail }).catch(() => {});
  }
}

/**
 * After the show ends: email each winner, and email each non-winner how close
 * they got. "Closeness" = position in the deterministic elimination order (the
 * last ticket out was 1 place from winning), which anyone can verify.
 */
export async function sendResults(raffleId: string) {
  const raffle = await db.raffle.findUnique({ where: { id: raffleId }, include: { show: true } });
  if (!raffle?.show) return;
  const show = raffle.show.stages as any; // { winnersCount, winners, stages }
  const tickets = await db.ticket.findMany({
    where: { raffleId },
    orderBy: { number: "asc" },
    include: { owner: { select: { email: true } } },
  });
  const N = tickets.length;
  const W = raffle.winnersCount;
  const winnerIdx = new Set<number>(show.winners ?? []);
  const winnerNumbers = (show.winners ?? []).map((i: number) => tickets[i]?.number).filter(Boolean);

  // Global elimination order → position of each ticket index.
  const posOf = new Map<number, number>();
  let i = 0;
  for (const st of show.stages ?? []) for (const idx of st.eliminated ?? []) posOf.set(idx, i++);

  // Users who won with ANY ticket - they only get the winner email, never the
  // "estuviste cerca" one (even if they also hold losing tickets).
  const winnerUserIds = new Set<string>();
  for (const wi of show.winners ?? []) {
    const t = tickets[wi];
    if (t?.ownerId) winnerUserIds.add(t.ownerId);
  }

  // Winners: one email per winning USER (dedupe multi-ticket winners).
  const emailedWinners = new Set<string>();
  for (const wi of show.winners ?? []) {
    const t = tickets[wi];
    if (!t?.ownerId || !t.owner?.email || emailedWinners.has(t.ownerId)) continue;
    emailedWinners.add(t.ownerId);
    await sendEmail({ to: t.owner.email, ...winnerEmail(raffle.title, t.number, raffle.slug) }).catch(() => {});
  }

  // Non-winners: best (smallest) "lugares del ganar" per user. Skip anyone who
  // won with another ticket.
  const best = new Map<string, { email: string; lugares: number }>();
  tickets.forEach((t, idx) => {
    if (winnerIdx.has(idx) || !t.ownerId || !t.owner?.email) return;
    if (winnerUserIds.has(t.ownerId)) return; // won elsewhere → no "close" email
    const p = posOf.get(idx);
    if (p === undefined) return;
    const lugares = N - W - p; // last eliminated → 1
    const cur = best.get(t.ownerId);
    if (!cur || lugares < cur.lugares) best.set(t.ownerId, { email: t.owner.email, lugares });
  });
  for (const { email, lugares } of best.values()) {
    await sendEmail({ to: email, ...resultsEmail(raffle.title, raffle.slug, winnerNumbers, lugares) }).catch(() => {});
  }
}

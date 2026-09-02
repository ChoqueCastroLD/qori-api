import { db } from "../db";

// A "Suertudo" is a user who has bought at least one lingote with real money
// (>= 1 PAID top-up). Used to award the golden badge/border across the app.
export async function suertudoSet(userIds: (string | null | undefined)[]): Promise<Set<string>> {
  const ids = [...new Set(userIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Set();
  const rows = await db.topUp.findMany({
    where: { userId: { in: ids }, status: "PAID" },
    distinct: ["userId"],
    select: { userId: true },
  });
  return new Set(rows.map((r) => r.userId));
}

export async function isSuertudo(userId: string): Promise<boolean> {
  return (await db.topUp.count({ where: { userId, status: "PAID" } })) > 0;
}

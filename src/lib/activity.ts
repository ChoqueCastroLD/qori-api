import { db } from "../db";

// Append a public activity event (profile changes). Best-effort; never throws.
export async function logActivity(userId: string, type: "username_change" | "avatar_change", data: any): Promise<void> {
  await db.activity.create({ data: { userId, type, data } }).catch(() => {});
}

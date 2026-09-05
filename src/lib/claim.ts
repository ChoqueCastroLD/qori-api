// Prize claim codes: short, human-readable, unambiguous (no 0/O/1/I). Format
// QORI-XXXX-XXXX. The winner reveals it ONLY to @shoko_cc on Discord to redeem.
import { db } from "../db";

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0 O 1 I L

function randomCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return `QORI-${s.slice(0, 4)}-${s.slice(4, 8)}`;
}

/** A claim code guaranteed not to collide with an existing one. */
export async function newClaimCode(): Promise<string> {
  for (let i = 0; i < 12; i++) {
    const code = randomCode();
    const exists = await db.winner.findUnique({ where: { claimCode: code }, select: { id: true } });
    if (!exists) return code;
  }
  // Astronomically unlikely; fall back to a longer code.
  return `${randomCode()}-${randomCode().slice(5)}`;
}

/** Claim code unique across BOTH winner tables (show + bingo share the namespace). */
export async function newBingoClaimCode(): Promise<string> {
  for (let i = 0; i < 12; i++) {
    const code = randomCode();
    const [w, b] = await Promise.all([
      db.winner.findUnique({ where: { claimCode: code }, select: { id: true } }),
      db.bingoWin.findUnique({ where: { claimCode: code }, select: { id: true } }),
    ]);
    if (!w && !b) return code;
  }
  return `${randomCode()}-${randomCode().slice(5)}`;
}

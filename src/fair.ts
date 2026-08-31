/**
 * @qori/fair - Provably-fair draw engine.
 *
 * Trust model (commit–reveal + public entropy):
 *
 *  1. COMMIT   When a raffle opens, the server generates a random `serverSeed`
 *              and publishes `commitment = sha256(serverSeed)`. This proves the
 *              seed was fixed *before* anyone could know the outcome.
 *
 *  2. ENTROPY  A public, future, operator-uncontrollable value is chosen in
 *              advance (e.g. a Bitcoin block hash at a target height, or a
 *              national-lottery result on the closing date). The operator cannot
 *              grind it, so they cannot steer the winner.
 *
 *  3. DRAW     winnerIndex = int(HMAC_SHA256(serverSeed, publicEntropy)) mod nTickets
 *              Deterministic: same inputs → same winner, forever.
 *
 *  4. REVEAL   The server reveals `serverSeed`. Anyone recomputes the commitment
 *              and the winner and confirms both match. No trust required.
 *
 * This module is pure and dependency-free (Web Crypto). It is the single source
 * of truth for draw math - the API imports it, and the public verifier page
 * imports the *same* code so users verify with identical logic.
 */

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** SHA-256 hex digest of a UTF-8 string. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return toHex(digest);
}

/** HMAC-SHA256(key, message) as hex. */
export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return toHex(sig);
}

/**
 * Generate a fresh commitment for a new raffle.
 * Keep `serverSeed` secret until the reveal; publish `commitment` immediately.
 */
export async function createCommitment(): Promise<{
  serverSeed: string;
  commitment: string;
}> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const serverSeed = toHex(bytes.buffer);
  const commitment = await sha256Hex(serverSeed);
  return { serverSeed, commitment };
}

export interface DrawInput {
  /** Secret seed committed to at raffle open. */
  serverSeed: string;
  /** Public entropy fixed AFTER the raffle closed (block hash, lottery result…). */
  publicEntropy: string;
  /** Number of tickets sold / eligible. Must be a positive integer. */
  ticketCount: number;
}

export interface DrawResult {
  /** 0-based index of the winning ticket in the canonical ordered list. */
  winnerIndex: number;
  /** 1-based ticket number, convenient for display. */
  winnerNumber: number;
  /** The HMAC digest the index was derived from (for auditability). */
  digest: string;
}

/**
 * Deterministically compute the winning ticket.
 *
 * The winner is an index into the raffle's canonical ticket ordering (tickets
 * sorted by issue order). Uses the full 256-bit HMAC as a big integer to avoid
 * modulo bias for any realistic ticket count.
 */
export async function computeWinner(input: DrawInput): Promise<DrawResult> {
  const { serverSeed, publicEntropy, ticketCount } = input;
  if (!Number.isInteger(ticketCount) || ticketCount <= 0) {
    throw new Error(`ticketCount must be a positive integer, got ${ticketCount}`);
  }
  const digest = await hmacSha256Hex(serverSeed, publicEntropy);
  const winnerIndex = Number(BigInt("0x" + digest) % BigInt(ticketCount));
  return { winnerIndex, winnerNumber: winnerIndex + 1, digest };
}

/**
 * Independent verification, mirroring what a skeptical user runs.
 * Returns true only if the revealed seed matches the published commitment AND
 * reproduces the claimed winner.
 */
export async function verifyDraw(params: {
  serverSeed: string;
  commitment: string;
  publicEntropy: string;
  ticketCount: number;
  claimedWinnerIndex: number;
}): Promise<{ ok: boolean; commitmentOk: boolean; winnerOk: boolean; recomputed: DrawResult }> {
  const commitmentOk = (await sha256Hex(params.serverSeed)) === params.commitment;
  const recomputed = await computeWinner(params);
  const winnerOk = recomputed.winnerIndex === params.claimedWinnerIndex;
  return { ok: commitmentOk && winnerOk, commitmentOk, winnerOk, recomputed };
}

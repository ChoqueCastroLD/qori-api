// Bingo engine: 5x5 classic B-I-N-G-O cards, provably-fair ball order, and
// full-card (blackout) win detection with ties. The ball order is derived
// deterministically from the raffle's drawDigest (HMAC(serverSeed, entropy)),
// so anyone can reproduce it. Center cell is FREE (24 numbers to complete).

export const COLUMNS = ["B", "I", "N", "G", "O"] as const;
export type Column = (typeof COLUMNS)[number];
export const COLUMN_RANGE: Record<Column, [number, number]> = {
  B: [1, 15], I: [16, 30], N: [31, 45], G: [46, 60], O: [61, 75],
};
export const POOL_SIZE = 75;

// A card: 5 numbers per column, except N which has 4 (center is free = null).
export interface BingoCard {
  B: number[]; I: number[]; N: (number | null)[]; G: number[]; O: number[];
}

// ---- Deterministic PRNG (sfc32) seeded from a hex string. Reproducible in any
// language, so the draw is verifiable. ----
function seedFromHex(hex: string): [number, number, number, number] {
  const h = hex.replace(/[^0-9a-f]/gi, "").padEnd(32, "0");
  const u = (i: number) => parseInt(h.slice(i * 8, i * 8 + 8) || "0", 16) >>> 0;
  return [u(0), u(1), u(2), u(3)];
}
function sfc32(a: number, b: number, c: number, d: number): () => number {
  return function () {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0; t = (t + d) | 0; c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}
export function rngFromHex(hex: string): () => number {
  const [a, b, c, d] = seedFromHex(hex);
  const r = sfc32(a, b, c, d);
  for (let i = 0; i < 15; i++) r(); // warm up
  return r;
}

function pickDistinct(rand: () => number, min: number, max: number, count: number): number[] {
  const pool: number[] = [];
  for (let n = min; n <= max; n++) pool.push(n);
  // partial Fisher-Yates
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(rand() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count).sort((x, y) => x - y);
}

// Generate a valid random card (columns in range, distinct, center free).
export function generateCard(rand: () => number): BingoCard {
  const N = pickDistinct(rand, 31, 45, 4);
  return {
    B: pickDistinct(rand, 1, 15, 5),
    I: pickDistinct(rand, 16, 30, 5),
    N: [N[0], N[1], null, N[2], N[3]], // center free
    G: pickDistinct(rand, 46, 60, 5),
    O: pickDistinct(rand, 61, 75, 5),
  };
}

// The 24 numbers on a card (center excluded).
export function cardNumbers(card: BingoCard): number[] {
  return [...card.B, ...card.I, ...(card.N.filter((n): n is number => n != null)), ...card.G, ...card.O];
}

// Canonical key of a card's number SET, for uniqueness (position doesn't matter
// for a full-card win, and each number's column is fixed by its value).
export function cardKey(card: BingoCard): string {
  return cardNumbers(card).slice().sort((a, b) => a - b).join(",");
}

// Validate a (possibly user-edited) card: each column filled from its own range,
// no repeats, exactly the right counts, center free.
export function validateCard(card: BingoCard): boolean {
  const check = (arr: (number | null)[], col: Column, count: number) => {
    const [lo, hi] = COLUMN_RANGE[col];
    const nums = arr.filter((n): n is number => n != null);
    if (nums.length !== count) return false;
    if (new Set(nums).size !== nums.length) return false;
    return nums.every((n) => Number.isInteger(n) && n >= lo && n <= hi);
  };
  return (
    check(card.B, "B", 5) && check(card.I, "I", 5) && check(card.N, "N", 4) &&
    check(card.G, "G", 5) && check(card.O, "O", 5) &&
    card.N.length === 5 && card.N[2] == null
  );
}

// ---- Storage form (cols) <-> logical card. The DB stores N as 4 numbers (the
// center FREE cell is implicit); a logical BingoCard keeps N as length-5 with a
// null center so the engine and frontend share one shape. ----
export interface BingoCols {
  B: number[]; I: number[]; N: number[]; G: number[]; O: number[];
}

export function cardToCols(card: BingoCard): BingoCols {
  return {
    B: [...card.B], I: [...card.I],
    N: card.N.filter((n): n is number => n != null),
    G: [...card.G], O: [...card.O],
  };
}

export function colsToCard(cols: BingoCols): BingoCard {
  const n = cols.N ?? [];
  return { B: cols.B, I: cols.I, N: [n[0] ?? null, n[1] ?? null, null, n[2] ?? null, n[3] ?? null], G: cols.G, O: cols.O };
}

export function validateCols(cols: BingoCols): boolean {
  return validateCard(colsToCard(cols));
}

export function colsKey(cols: BingoCols): string {
  return cardKey(colsToCard(cols));
}

/** Which letter/column a ball number belongs to. */
export function letterOf(n: number): Column {
  if (n <= 15) return "B";
  if (n <= 30) return "I";
  if (n <= 45) return "N";
  if (n <= 60) return "G";
  return "O";
}

/** Live progress of a card against the drawn set: marks (center FREE counts)
 *  and the fully-completed columns. Used to render each participant's status. */
export function progress(cols: BingoCols, drawn: Set<number>): { marks: number; letters: Column[] } {
  const letters: Column[] = [];
  let marks = 1; // center FREE is always marked
  const perCol: [Column, number[]][] = [["B", cols.B], ["I", cols.I], ["N", cols.N], ["G", cols.G], ["O", cols.O]];
  for (const [L, arr] of perCol) {
    let full = arr.length > 0;
    for (const n of arr) { if (drawn.has(n)) marks++; else full = false; }
    if (full) letters.push(L);
  }
  return { marks, letters };
}

// Provably-fair ball order: a permutation of 1..75 from the draw digest.
export function ballOrder(digestHex: string): number[] {
  const rand = rngFromHex(digestHex);
  const balls: number[] = [];
  for (let n = 1; n <= POOL_SIZE; n++) balls.push(n);
  for (let i = POOL_SIZE - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [balls[i], balls[j]] = [balls[j], balls[i]];
  }
  return balls;
}

// The 0-based draw index at which a card completes (its last number is drawn).
export function completionIndex(card: BingoCard, order: number[]): number {
  const pos = new Map<number, number>();
  order.forEach((ball, i) => pos.set(ball, i));
  let last = -1;
  for (const n of cardNumbers(card)) {
    const p = pos.get(n);
    if (p == null) return Infinity; // shouldn't happen for valid cards
    if (p > last) last = p;
  }
  return last;
}

// Winner(s): the card(s) with the smallest completion index. Ties = all cards
// that complete on the same (earliest) ball -> prize is split equally.
export function findWinners<T extends { card: BingoCard }>(
  cards: T[],
  order: number[],
): { winners: T[]; winningBallIndex: number } {
  let best = Infinity;
  let winners: T[] = [];
  for (const c of cards) {
    const idx = completionIndex(c.card, order);
    if (idx < best) { best = idx; winners = [c]; }
    else if (idx === best) winners.push(c);
  }
  return { winners, winningBallIndex: best === Infinity ? -1 : best };
}

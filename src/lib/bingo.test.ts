import { test, expect } from "bun:test";
import {
  rngFromHex, generateCard, cardNumbers, cardKey, validateCard,
  ballOrder, completionIndex, findWinners, COLUMN_RANGE, type BingoCard,
  cardToCols, colsToCard, validateCols, colsKey, progress, letterOf,
} from "./bingo";

const DIGEST = "a3f1c9e2b47d80516e2c9f0a1b3d5e7f90a2c4b6d8e0f1234567890abcdef1234";

test("generated card is valid: columns in range, distinct, center free, 24 numbers", () => {
  const r = rngFromHex(DIGEST);
  for (let k = 0; k < 200; k++) {
    const c = generateCard(r);
    expect(validateCard(c)).toBe(true);
    expect(cardNumbers(c).length).toBe(24);
    expect(c.N[2]).toBe(null);
    for (const col of ["B", "I", "N", "G", "O"] as const) {
      const [lo, hi] = COLUMN_RANGE[col];
      for (const n of c[col]) if (n != null) { expect(n).toBeGreaterThanOrEqual(lo); expect(n).toBeLessThanOrEqual(hi); }
    }
  }
});

test("ball order is a full permutation of 1..75 and deterministic from digest", () => {
  const a = ballOrder(DIGEST);
  const b = ballOrder(DIGEST);
  expect(a).toEqual(b); // reproducible
  expect(a.length).toBe(75);
  expect(new Set(a).size).toBe(75);
  expect(Math.min(...a)).toBe(1);
  expect(Math.max(...a)).toBe(75);
  expect(ballOrder(DIGEST.replace("a", "b"))).not.toEqual(a); // different seed -> different order
});

test("cardKey is order-independent set key; validateCard rejects bad cards", () => {
  const c1: BingoCard = { B: [1, 2, 3, 4, 5], I: [16, 17, 18, 19, 20], N: [31, 32, null, 33, 34], G: [46, 47, 48, 49, 50], O: [61, 62, 63, 64, 65] };
  const c2: BingoCard = { ...c1, B: [5, 4, 3, 2, 1] }; // same set, different order
  expect(cardKey(c1)).toBe(cardKey(c2));
  expect(validateCard(c1)).toBe(true);
  expect(validateCard({ ...c1, B: [1, 2, 3, 4, 99] })).toBe(false); // 99 out of B range
  expect(validateCard({ ...c1, B: [1, 1, 3, 4, 5] })).toBe(false); // repeat
  expect(validateCard({ ...c1, N: [31, 32, 40, 33, 34] })).toBe(false); // center not free
});

test("win detection: earliest completing card wins; exact tie splits", () => {
  // Build a tiny synthetic order and cards to check the math directly.
  const A: BingoCard = { B: [1], I: [16], N: [null, null, null, null, null], G: [], O: [] } as any;
  const B: BingoCard = { B: [1], I: [17], N: [null, null, null, null, null], G: [], O: [] } as any;
  const C: BingoCard = { B: [2], I: [16], N: [null, null, null, null, null], G: [], O: [] } as any;
  const order = [16, 17, 2, 1]; // A completes at ball 1 (idx3), B at ball 17(idx1)... wait recompute
  // A numbers {1,16}: last drawn = 1 at idx3. B {1,17}: last = 1 at idx3. C {2,16}: last = 2 at idx2.
  expect(completionIndex(A, order)).toBe(3);
  expect(completionIndex(B, order)).toBe(3);
  expect(completionIndex(C, order)).toBe(2);
  const res = findWinners([{ card: A, id: "A" }, { card: B, id: "B" }, { card: C, id: "C" }], order);
  expect(res.winners.map((w) => (w as any).id)).toEqual(["C"]); // C completes first
  // Now a real tie: A and B both complete at idx3 if we drop C
  const res2 = findWinners([{ card: A, id: "A" }, { card: B, id: "B" }], order);
  expect(res2.winners.map((w) => (w as any).id).sort()).toEqual(["A", "B"]); // tie -> split
});

test("cols <-> card round-trips; validateCols + colsKey mirror the card form", () => {
  const r = rngFromHex(DIGEST);
  for (let k = 0; k < 100; k++) {
    const card = generateCard(r);
    const cols = cardToCols(card);
    expect(cols.N.length).toBe(4); // center dropped in storage form
    const back = colsToCard(cols);
    expect(back.N[2]).toBe(null); // center restored as FREE
    expect(cardKey(back)).toBe(cardKey(card)); // same 24-number set
    expect(colsKey(cols)).toBe(cardKey(card));
    expect(validateCols(cols)).toBe(true);
  }
  // A tampered column (out of range) is rejected in cols form too.
  const bad = cardToCols(generateCard(r));
  bad.B[0] = 99;
  expect(validateCols(bad)).toBe(false);
});

test("letterOf maps numbers to columns at the boundaries", () => {
  expect([1, 15].map(letterOf)).toEqual(["B", "B"]);
  expect([16, 30].map(letterOf)).toEqual(["I", "I"]);
  expect([31, 45].map(letterOf)).toEqual(["N", "N"]);
  expect([46, 60].map(letterOf)).toEqual(["G", "G"]);
  expect([61, 75].map(letterOf)).toEqual(["O", "O"]);
});

test("progress: FREE always marked; a fully-drawn column completes", () => {
  const cols = { B: [1, 2, 3, 4, 5], I: [16, 17, 18, 19, 20], N: [31, 32, 33, 34], G: [46, 47, 48, 49, 50], O: [61, 62, 63, 64, 65] };
  expect(progress(cols, new Set()).marks).toBe(1); // only the center
  expect(progress(cols, new Set()).letters).toEqual([]);
  // Draw exactly the B column -> B completes, marks = 1 (free) + 5.
  const bDrawn = progress(cols, new Set([1, 2, 3, 4, 5]));
  expect(bDrawn.letters).toEqual(["B"]);
  expect(bDrawn.marks).toBe(6);
  // Draw the N column's 4 numbers -> N completes (center is free).
  expect(progress(cols, new Set([31, 32, 33, 34])).letters).toEqual(["N"]);
  // Full card -> all 5 letters, 25 marks (24 numbers + free).
  const all = new Set([...cols.B, ...cols.I, ...cols.N, ...cols.G, ...cols.O]);
  const full = progress(cols, all);
  expect(full.letters).toEqual(["B", "I", "N", "G", "O"]);
  expect(full.marks).toBe(25);
});

test("prize split on tie: shares sum to prizeValue, odd cents to the first", () => {
  // Mirror the executeBingoDraw split math for a 3-way tie on 550.00 USD.
  const prizeValue = 55000; // cents
  const n = 3;
  const base = Math.floor(prizeValue / n);
  const remainder = prizeValue - base * n;
  const shares = Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
  expect(shares.reduce((a, b) => a + b, 0)).toBe(prizeValue); // exact
  expect(shares).toEqual([18334, 18333, 18333]);
});

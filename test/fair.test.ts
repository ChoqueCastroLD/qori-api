import { describe, expect, test } from "bun:test";
import {
  createCommitment,
  computeWinner,
  sha256Hex,
  verifyDraw,
} from "../src/fair";

describe("provably-fair core", () => {
  test("commitment is sha256 of the seed", async () => {
    const { serverSeed, commitment } = await createCommitment();
    expect(commitment).toBe(await sha256Hex(serverSeed));
    expect(serverSeed).toMatch(/^[0-9a-f]{64}$/);
  });

  test("draw is deterministic for the same inputs", async () => {
    const input = { serverSeed: "abc123", publicEntropy: "block:840000", ticketCount: 1000 };
    const a = await computeWinner(input);
    const b = await computeWinner(input);
    expect(a).toEqual(b);
    expect(a.winnerIndex).toBeGreaterThanOrEqual(0);
    expect(a.winnerIndex).toBeLessThan(1000);
    expect(a.winnerNumber).toBe(a.winnerIndex + 1);
  });

  test("different entropy generally changes the winner", async () => {
    const base = { serverSeed: "seed", ticketCount: 5000 };
    const a = await computeWinner({ ...base, publicEntropy: "A" });
    const b = await computeWinner({ ...base, publicEntropy: "B" });
    // Not guaranteed, but astronomically unlikely to collide across 5000 slots.
    expect(a.winnerIndex).not.toBe(b.winnerIndex);
  });

  test("rejects invalid ticket counts", async () => {
    for (const bad of [0, -1, 1.5, NaN]) {
      await expect(
        computeWinner({ serverSeed: "s", publicEntropy: "e", ticketCount: bad }),
      ).rejects.toThrow();
    }
  });

  test("distribution is roughly uniform (no gross bias)", async () => {
    const slots = 10;
    const counts = new Array(slots).fill(0);
    const N = 3000;
    for (let i = 0; i < N; i++) {
      const { winnerIndex } = await computeWinner({
        serverSeed: "fixed-seed",
        publicEntropy: `draw-${i}`,
        ticketCount: slots,
      });
      counts[winnerIndex]++;
    }
    const expected = N / slots;
    // Each bucket should be within ~35% of expected — loose sanity, not a chi-sq.
    for (const c of counts) {
      expect(c).toBeGreaterThan(expected * 0.65);
      expect(c).toBeLessThan(expected * 1.35);
    }
  });

  test("end-to-end verify passes for an honest draw and fails when tampered", async () => {
    const { serverSeed, commitment } = await createCommitment();
    const publicEntropy = "btc-block-hash-0000abcd";
    const ticketCount = 777;
    const result = await computeWinner({ serverSeed, publicEntropy, ticketCount });

    const good = await verifyDraw({
      serverSeed,
      commitment,
      publicEntropy,
      ticketCount,
      claimedWinnerIndex: result.winnerIndex,
    });
    expect(good.ok).toBe(true);

    // Operator lies about the winner:
    const tampered = await verifyDraw({
      serverSeed,
      commitment,
      publicEntropy,
      ticketCount,
      claimedWinnerIndex: (result.winnerIndex + 1) % ticketCount,
    });
    expect(tampered.ok).toBe(false);
    expect(tampered.winnerOk).toBe(false);
    expect(tampered.commitmentOk).toBe(true);

    // Operator swaps the seed after committing:
    const swapped = await verifyDraw({
      serverSeed: serverSeed.replace(/.$/, (c) => (c === "0" ? "1" : "0")),
      commitment,
      publicEntropy,
      ticketCount,
      claimedWinnerIndex: result.winnerIndex,
    });
    expect(swapped.commitmentOk).toBe(false);
    expect(swapped.ok).toBe(false);
  });
});

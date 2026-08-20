/**
 * Deterministic gamified-show generator.
 *
 * The winners AND the entire on-screen sequence (elimination order, bomb
 * placement, squid rounds, horse steps, digit reveals) are a pure function of
 * the draw `digest` = HMAC(serverSeed, publicEntropy). Anyone with the revealed
 * seed can reproduce the show bit-for-bit — see docs/FAIRNESS.md.
 *
 * The PRNG is `sfc32` seeded from 128 bits of the digest. It is a non-crypto
 * generator used only to EXPAND the crypto-strong digest into a reproducible
 * stream; unpredictability comes from the digest being secret until reveal.
 */

export type GameType = "ELIMINATION" | "DIGIT_REVEAL" | "BOMBS" | "SQUID" | "HORSE_RACE";

/** sfc32 seeded from 4x32-bit words taken from the digest hex. */
export function makeRng(digestHex: string): () => number {
  let a = parseInt(digestHex.slice(0, 8), 16) >>> 0;
  let b = parseInt(digestHex.slice(8, 16), 16) >>> 0;
  let c = parseInt(digestHex.slice(16, 24), 16) >>> 0;
  let d = parseInt(digestHex.slice(24, 32), 16) >>> 0;
  return function () {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, n: number): number {
  return Math.floor(rng() * n);
}

/** Fisher–Yates shuffle driven by the deterministic rng. */
function shuffle<T>(rng: () => number, arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface ShowStage {
  game: GameType;
  isFinale: boolean;
  /** ticket indices (0-based) eliminated during this stage, in animation order */
  eliminated: number[];
  /** ticket indices still alive when this stage begins */
  aliveBefore: number[];
  /** extra per-game rendering data */
  data: Record<string, unknown>;
}

export interface Show {
  ticketCount: number;
  winnersCount: number;
  /** winning ticket indices (0-based), in finish order (1st place first) */
  winners: number[];
  stages: ShowStage[];
}

const MAX_ANIM = 60; // cap eliminations animated per stage for huge raffles

/**
 * Build the full show. `games` is the set of enabled game types; their order is
 * randomized deterministically and `finale` (if provided) is forced last.
 */
export function generateShow(opts: {
  digest: string;
  ticketCount: number;
  winnersCount: number;
  games: GameType[];
  finale?: GameType | null;
}): Show {
  const { digest, ticketCount } = opts;
  const winnersCount = Math.max(1, Math.min(opts.winnersCount, ticketCount));
  const rng = makeRng(digest);

  // 1) Pick winners (distinct), in finish order.
  const pool = shuffle(rng, Array.from({ length: ticketCount }, (_, i) => i));
  const winners = pool.slice(0, winnersCount);
  const winnerSet = new Set(winners);

  // 2) Losers in a deterministic elimination order.
  const losers = shuffle(rng, pool.filter((i) => !winnerSet.has(i)));

  // 3) Stage order: shuffle non-finale games, force finale last.
  let games = opts.games.length ? [...new Set(opts.games)] : (["ELIMINATION"] as GameType[]);
  const finale = opts.finale && games.includes(opts.finale) ? opts.finale : games[games.length - 1];
  const rest = shuffle(rng, games.filter((g) => g !== finale));
  const order: GameType[] = [...rest, finale];

  // 4) Distribute losers across stages; the finale reveals the winners.
  const stages: ShowStage[] = [];
  let alive = pool.slice(); // everyone alive at start
  const nStages = order.length;
  // Each non-finale stage eliminates a share of losers; finale eliminates the rest.
  let cursor = 0;
  order.forEach((game, idx) => {
    const isFinale = idx === nStages - 1;
    let chunk: number[];
    if (isFinale) {
      chunk = losers.slice(cursor);
    } else {
      const remainingStages = nStages - idx;
      const remainingLosers = losers.length - cursor;
      const take = Math.max(1, Math.round(remainingLosers / remainingStages));
      chunk = losers.slice(cursor, cursor + take);
      cursor += take;
    }
    const aliveBefore = alive.slice();
    alive = alive.filter((i) => !chunk.includes(i));
    stages.push({
      game,
      isFinale,
      eliminated: chunk,
      aliveBefore,
      data: buildGameData(rng, game, isFinale, chunk, aliveBefore, winners, ticketCount),
    });
  });

  return { ticketCount, winnersCount, winners, stages };
}

/** Per-game rendering payload. Deterministic (rng-driven where needed). */
function buildGameData(
  rng: () => number,
  game: GameType,
  isFinale: boolean,
  eliminated: number[],
  aliveBefore: number[],
  winners: number[],
  ticketCount: number,
): Record<string, unknown> {
  switch (game) {
    case "BOMBS": {
      // Split eliminations into "explosion" phases of a few tickets each.
      const phases: number[][] = [];
      const size = Math.max(1, Math.ceil(eliminated.length / Math.max(1, Math.min(6, eliminated.length))));
      for (let i = 0; i < eliminated.length; i += size) phases.push(eliminated.slice(i, i + size));
      return { phases: phases.slice(0, MAX_ANIM) };
    }
    case "SQUID": {
      // Alternating green/red rounds; reds cull a batch.
      const rounds: { light: "green" | "red"; eliminated: number[] }[] = [];
      const size = Math.max(1, Math.ceil(eliminated.length / 5));
      for (let i = 0; i < eliminated.length; i += size) {
        rounds.push({ light: "green", eliminated: [] });
        rounds.push({ light: "red", eliminated: eliminated.slice(i, i + size) });
      }
      return { rounds: rounds.slice(0, MAX_ANIM) };
    }
    case "HORSE_RACE": {
      // Racers = alive tickets; losers "fall back", winners cross the line.
      const lanes = aliveBefore.slice(0, 12);
      const steps = 6 + randInt(rng, 4);
      return { lanes, steps, eliminated: eliminated.slice(0, MAX_ANIM) };
    }
    case "DIGIT_REVEAL": {
      const digits = String(ticketCount).length;
      const winnerNumbers = winners.map((w) => String(w + 1).padStart(digits, "0"));
      // Reveal digit positions in a shuffled order for suspense.
      const revealOrder = shuffle(rng, Array.from({ length: digits }, (_, i) => i));
      return { winnerNumbers, revealOrder, eliminated: eliminated.slice(0, MAX_ANIM) };
    }
    case "ELIMINATION":
    default:
      return { eliminated: eliminated.slice(0, MAX_ANIM) };
  }
}

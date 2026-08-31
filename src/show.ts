/**
 * Deterministic gamified-show generator.
 *
 * The winners AND the entire on-screen sequence (elimination order, bomb
 * placement, squid rounds, horse steps, digit reveals) are a pure function of
 * the draw `digest` = HMAC(serverSeed, publicEntropy). Anyone with the revealed
 * seed can reproduce the show bit-for-bit - see docs/FAIRNESS.md.
 *
 * The PRNG is `sfc32` seeded from 128 bits of the digest. It is a non-crypto
 * generator used only to EXPAND the crypto-strong digest into a reproducible
 * stream; unpredictability comes from the digest being secret until reveal.
 */

export type GameType =
  | "ELIMINATION"
  | "DIGIT_REVEAL"
  | "BOMBS"
  | "SQUID"
  | "HORSE_RACE"
  | "ICE_FLOOR"
  | "MUSICAL_CHAIRS"
  | "ROCKETS"
  | "ROULETTE";

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
    case "ROCKETS": {
      // Meteor "waves": each strike takes out a batch of the nearest tickets.
      const waves: number[][] = [];
      const size = Math.max(1, Math.ceil(eliminated.length / Math.max(1, Math.min(6, eliminated.length))));
      for (let i = 0; i < eliminated.length; i += size) waves.push(eliminated.slice(i, i + size));
      return { waves: waves.slice(0, MAX_ANIM) };
    }
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
      // Racers: every eliminated ticket must be on track (so its fall is seen),
      // plus survivors to contest the finish. Lane order is shuffled so the
      // doomed aren't clustered. Capped to keep lanes readable.
      const CAP = 14;
      const survivors = aliveBefore.filter((i) => !eliminated.includes(i));
      const elimLanes = eliminated.slice(0, Math.min(eliminated.length, CAP - Math.min(2, survivors.length)));
      const survLanes = shuffle(rng, survivors).slice(0, CAP - elimLanes.length);
      const lanes = shuffle(rng, [...elimLanes, ...survLanes]);
      const steps = 6 + randInt(rng, 4);
      return { lanes, steps, eliminated: eliminated.slice(0, MAX_ANIM) };
    }
    case "ICE_FLOOR": {
      // Escalating waves of cracking ice; each wave drops a batch through.
      const waves: number[][] = [];
      const nWaves = Math.max(1, Math.min(4, Math.ceil(eliminated.length / 3)));
      const size = Math.max(1, Math.ceil(eliminated.length / nWaves));
      for (let i = 0; i < eliminated.length; i += size) waves.push(eliminated.slice(i, i + size));
      return { waves: waves.slice(0, MAX_ANIM) };
    }
    case "MUSICAL_CHAIRS": {
      // 2-3 rounds; each removes ~10% of those still circling (at least 1),
      // so chairs = alive - max(1, round(0.10 * alive)). Remainder goes to the
      // last round so the stage always eliminates exactly its chunk.
      const rounds: number[][] = [];
      let alive = aliveBefore.length;
      let cur = 0;
      const maxRounds = Math.min(3, Math.max(1, eliminated.length));
      for (let r = 0; r < maxRounds && cur < eliminated.length; r++) {
        const isLast = r === maxRounds - 1;
        const k = isLast ? eliminated.length - cur : Math.min(eliminated.length - cur, Math.max(1, Math.round(alive * 0.1)));
        rounds.push(eliminated.slice(cur, cur + k));
        cur += k;
        alive -= k;
      }
      return { rounds: rounds.slice(0, MAX_ANIM) };
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

// ===========================================================================
// Show algorithm v2 - one drand digest seeds deterministic PER-GAME sims that
// run server-side; the WINNERS are whoever survives all three games (no
// pre-shuffle). Fixed public counts: games 1+2 leave exactly 10 finalists
// (split N-10 in half, first game takes the extra), the finale narrows 10 to
// the winners. Every victim choice is a pure function of the digest, so anyone
// can reproduce it. Requires >= 20 tickets; below that it falls back to v1.
// ===========================================================================

export const FINALISTS = 10;
export const MIN_TICKETS_V2 = 20;

/** Rockets: a seeded subset is struck by meteor waves (hits are individual, so
 * an arbitrary fair subset is fine). Grouped into ~6 waves for the animation. */
function rocketsSim(rng: () => number, alive: number[], take: number): { eliminated: number[]; data: Record<string, unknown> } {
  const victims = shuffle(rng, alive.slice()).slice(0, take);
  const waves: number[][] = [];
  const size = Math.max(1, Math.ceil(victims.length / Math.max(1, Math.min(6, victims.length))));
  for (let i = 0; i < victims.length; i += size) waves.push(victims.slice(i, i + size));
  return { eliminated: victims, data: { waves } };
}

/** Bombs "cruz errante": on a 10-column grid, remove tickets until exactly
 * `targetSurvivors` remain, choosing the mechanic by how many still must go -
 * CROSS (whole row+column) for big cuts, PINEAPPLE (host saved, nearest
 * neighbours out) for medium, JUMP (single) for the last few. Victims are pure
 * geometry from the current (reflowed) grid, so the choice is auditable and the
 * client can replay the exact same board from `gridOrder` + `events`. */
function bombsSim(rng: () => number, alive: number[], targetSurvivors: number): { eliminated: number[]; data: Record<string, unknown> } {
  const COLS = 10;
  let liv = shuffle(rng, alive.slice());
  const gridOrder = liv.slice();
  const events: Record<string, unknown>[] = [];
  const eliminated: number[] = [];
  const rowOf = (i: number) => Math.floor(i / COLS);
  const colOf = (i: number) => i % COLS;
  const remove = (victims: number[]) => { const vs = new Set(victims); liv = liv.filter((x) => !vs.has(x)); eliminated.push(...victims); };

  let guard = 0;
  while (liv.length > targetSurvivors && guard++ < 5000) {
    const rem = liv.length - targetSurvivors;
    const pos = new Map<number, number>(); liv.forEach((id, i) => pos.set(id, i));
    const dist = (id: number, r: number, c: number) => Math.abs(rowOf(pos.get(id)!) - r) + Math.abs(colOf(pos.get(id)!) - c);
    if (rem >= 8) {
      const target = liv[randInt(rng, liv.length)];
      const tr = rowOf(pos.get(target)!), tc = colOf(pos.get(target)!);
      let victims = liv.filter((id) => rowOf(pos.get(id)!) === tr || colOf(pos.get(id)!) === tc);
      victims.sort((a, b) => dist(a, tr, tc) - dist(b, tr, tc));
      if (victims.length > rem) victims = victims.slice(0, rem);
      events.push({ type: "cross", target, victims });
      remove(victims);
    } else if (rem >= 2) {
      const host = liv[randInt(rng, liv.length)];
      const hr = rowOf(pos.get(host)!), hc = colOf(pos.get(host)!);
      const victims = liv.filter((id) => id !== host).sort((a, b) => dist(a, hr, hc) - dist(b, hr, hc)).slice(0, rem);
      events.push({ type: "pine", host, victims });
      remove(victims);
    } else {
      const victim = liv[randInt(rng, liv.length)];
      const pool = liv.filter((id) => id !== victim);
      const decoys: number[] = [];
      for (let d = 0; d < Math.min(4, pool.length); d++) decoys.push(pool[randInt(rng, pool.length)]);
      events.push({ type: "jump", victim, decoys });
      remove([victim]);
    }
  }
  return { eliminated, data: { cols: COLS, gridSeed: (rng() * 4294967296) >>> 0, gridOrder, events } };
}

/** Ruleta rusa (finale): the finalists sit in a fixed ring (their slot never
 * moves; dead slots leave a gap). Each cycle loads 1..(alive-1) bullets into a
 * hidden 6-chamber cylinder at seeded positions, then fires 6 shots - each aims
 * a live slot; a loaded chamber is a BANG (that ticket is out), an empty one a
 * CLICK (spared). Cycles repeat until `survivorsCount` remain. The full shot
 * script is emitted so the client animates the exact clicks/bangs. */
function rouletteSim(rng: () => number, alive: number[], survivorsCount: number): { eliminated: number[]; survivors: number[]; data: Record<string, unknown> } {
  const slots = alive.slice();
  const N = slots.length;
  const dead = new Set<number>();
  const eliminated: number[] = [];
  const shots: Record<string, unknown>[] = [];
  let aliveN = N;
  let cycle = 0, guard = 0;

  while (aliveN > survivorsCount && guard++ < 2000) {
    cycle++;
    const bullets = Math.min(1 + Math.floor(rng() * 6), aliveN - 1);
    const chambers = Array(6).fill(false) as boolean[];
    const idx = [0, 1, 2, 3, 4, 5];
    for (let i = 5; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    for (let i = 0; i < bullets; i++) chambers[idx[i]] = true;

    const livSlots = slots.map((_, s) => s).filter((s) => !dead.has(s));
    let aimedSlot = livSlots[Math.floor(rng() * livSlots.length)];

    for (let shot = 0; shot < 6; shot++) {
      const hit = chambers[shot];
      shots.push({ cycle, bullets, shot, aimedSlot, aimed: slots[aimedSlot], hit });
      if (hit) { dead.add(aimedSlot); eliminated.push(slots[aimedSlot]); aliveN--; if (aliveN <= survivorsCount) break; }
      if (shot < 5 && aliveN > survivorsCount) { do { aimedSlot = (aimedSlot + 1) % N; } while (dead.has(aimedSlot)); }
    }
  }
  const survivors = slots.filter((_, s) => !dead.has(s));
  return { eliminated, survivors, data: { slots, shots } };
}

/** Finale dispatch. ROULETTE runs the revolver sim; anything else narrows the
 * field with a plain seeded elimination (survivors in finish order). */
function finaleSim(rng: () => number, game: GameType, alive: number[], survivorsCount: number): { eliminated: number[]; survivors: number[]; data: Record<string, unknown> } {
  if (game === "ROULETTE") return rouletteSim(rng, alive, survivorsCount);
  const order = shuffle(rng, alive.slice());
  const elimCount = Math.max(0, alive.length - survivorsCount);
  return { eliminated: order.slice(0, elimCount), survivors: order.slice(elimCount), data: { eliminated: order.slice(0, elimCount) } };
}

function gameSim(rng: () => number, game: GameType, alive: number[], take: number): { eliminated: number[]; data: Record<string, unknown> } {
  if (take <= 0) return { eliminated: [], data: {} };
  switch (game) {
    case "ROCKETS": return rocketsSim(rng, alive, take);
    case "BOMBS": return bombsSim(rng, alive, alive.length - take);
    default: {
      const victims = shuffle(rng, alive.slice()).slice(0, take);
      return { eliminated: victims, data: { eliminated: victims } };
    }
  }
}

export function generateShowV2(opts: {
  digest: string;
  ticketCount: number;
  winnersCount: number;
  games: GameType[];
  finale?: GameType | null;
}): Show {
  const N = opts.ticketCount;
  const W = Math.max(1, Math.min(opts.winnersCount, N));
  // Not enough tickets for the 3-game format (or too few games) → keep v1.
  if (N < MIN_TICKETS_V2 || opts.games.length < 2) return generateShow(opts);

  const rng = makeRng(opts.digest);
  const uniq = [...new Set(opts.games)] as GameType[];
  const finale = opts.finale && uniq.includes(opts.finale) ? opts.finale : uniq[uniq.length - 1];
  const nonFinaleGames = uniq.filter((g) => g !== finale);
  const order: GameType[] = [...nonFinaleGames, finale];
  const nonFinale = nonFinaleGames.length;

  const finalists = Math.min(FINALISTS, N);
  const toCut = N - finalists;
  const shares: number[] = [];
  for (let i = 0; i < nonFinale; i++) {
    const remStages = nonFinale - i;
    const already = shares.reduce((a, b) => a + b, 0);
    shares.push(Math.ceil((toCut - already) / remStages));
  }

  const stages: ShowStage[] = [];
  let alive = Array.from({ length: N }, (_, i) => i);
  let winners: number[] = [];

  order.forEach((game, idx) => {
    const isFinale = idx === order.length - 1;
    const aliveBefore = alive.slice();
    let elim: number[]; let data: Record<string, unknown>;
    if (isFinale) {
      const res = finaleSim(rng, game, aliveBefore, W);
      elim = res.eliminated; data = res.data; winners = res.survivors;
    } else {
      const take = Math.max(0, Math.min(shares[idx], aliveBefore.length - finalists));
      const res = gameSim(rng, game, aliveBefore, take);
      elim = res.eliminated; data = res.data;
    }
    const gone = new Set(elim);
    alive = alive.filter((i) => !gone.has(i));
    stages.push({ game, isFinale, eliminated: elim, aliveBefore, data });
  });

  return { ticketCount: N, winnersCount: W, winners, stages };
}

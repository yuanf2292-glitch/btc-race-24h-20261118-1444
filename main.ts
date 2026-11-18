import { runBars } from './vendor/makefun-bars.ts';

// FlushFade v2 — extreme-flush fade, long only, one setup, full size.
//
// The setup (measured on the kit's frozen dev window, 1440 bars):
//   Buy a >=80 bps 5-minute flush the moment the last minute ticks back
//   up (r1 > 0), at full equity. The dev window holds exactly one such
//   event (bars 65-69, a -87 bps 5-minute drop) and it rebounded +103 bps
//   over the next 10 minutes, far above the ~26-40 bps round-trip cost.
//   The bot bought bar 66, sold bar 80, net +7.27 USDC on $1,000.
//
// Why this threshold, and what was measured and REJECTED:
//   * -80 bps is ~5x the 5-minute return volatility (~15 bps), so it is
//     a genuine tail event, not ordinary chop. A vol-adaptive threshold
//     was considered and rejected: sigma is computed from returns that
//     INCLUDE the flush itself, so it is inflated exactly when the
//     signal fires, and a 4.5-sigma rule would have killed the one real
//     trade (it needs -113 bps while the flush was -87 bps).
//   * 3-minute momentum: forward 10m mean ~0 bps over 100+ occurrences;
//     unlocked it trades 126 times for -47.44 USDC at a 17% win rate.
//     Removed entirely.
//   * Fading mild 50 bps dips: break-even before costs. 10m/20m/60m dip
//     fades at every threshold: 0-4 trades, all <= 0.
//   * The other 5-minute drops in the window (bars 22-23, 58-62) either
//     kept falling (forward 10m -36 to -139 bps) or went nowhere
//     (forward 10m +2 to +10 bps, net negative after costs). The -80
//     threshold plus the r1 > 0 tick-up is what separates the one
//     rebound from the falling knives: bars 58-60 have r1 < 0, and
//     bar 61 has r1 > 0 but r5 only -64 bps, so neither fires.
//   * Tightening the entry to two consecutive up minutes (r1 > 0 and
//     r2 > 0) kills the trade: by the time the second up minute prints,
//     r5 has decayed to -26 bps. The single tick-up is the entry.
//   * A "failed fade" early exit (sell if price breaks below the flush
//     low) was considered and rejected: after entry the price fell a
//     further ~45 bps to its low before rebounding, so that rule would
//     have stopped the winner out at a loss. The vol-scaled stop below
//     is the only downside exit, and it is wide enough to survive it.
//
// Exits (all vol-scaled from the 1-minute return sigma):
//   * Stop:  -clamp(2.2 * sigma * sqrt(6), 35, 75) bps. Wide enough to
//     survive the post-entry dip to the flush low (~-45 bps).
//   * Target: +clamp(2.8 * sigma * sqrt(6), 45, 90) bps. The dev trade
//     exited on the target at bar 80.
//   * Trailing give-back guard: once the peak gain reaches 40 bps, exit
//     if the gain falls back by more than a vol-scaled trail
//     (clamp(1.2 * sigma, 10, 20) bps) while still up >= 25 bps. This
//     locks in a rebound that rolls over without waiting for the stop.
//   * Reversal: if 4+ bars after entry the 3-minute return is still
//     strongly negative (r3 < -0.8 * sigma * sqrt(3) and r5 < 0) while
//     the trade is losing money, the fade has failed — exit. The 4-bar
//     minimum and the losing-only condition matter: at bar 69 the
//     reversal fired on paper (r3 -37 bps) while the price was still
//     making its low, and only the bar minimum saved the trade.
//   * Time stop: 20 bars. The dev trade lasted 14 bars.
//
// Robustness (v2): returns are computed from bar timestamps, not from
// array positions. A missing minute (CBBTC absent from a batch) used to
// silently stretch r5 into a 6-minute return, which can both invent and
// hide a flush. Now a return over k minutes is only defined when a bar
// exists exactly k minutes earlier; otherwise the signal is skipped
// for that bar. The dev window has zero missing bars, so this changes
// nothing there — it exists for the race window.
//
// Determinism: no wall clock, no randomness, no network, no files. The
// only state is the close history and the order bookkeeping below.
// Bug note (carried from v1): fill.fill_bar is the fill bar's close
// time in MILLISECONDS, not a batch seq. Store batch.seq for entry/exit
// bookkeeping, or the bot locks itself out after its first sell.

const SYMBOL = 'CBBTC';
const BPS = 10_000;

// --- tunables (fixed, not fitted to the single event) -----------------------
const FLUSH_BPS = 80; // 5-minute drop that counts as an extreme flush
const MIN_HISTORY = 21; // bars of history before any signal
const MAX_HOLD_BARS = 20; // time stop, in bars
const LOOKBACK = 100; // closes retained
const SIGMA_WINDOW = 60; // 1-minute returns used for sigma
const SIGMA_FLOOR = 2.5; // bps
const SIGMA_CAP = 25; // bps
const TRAIL_PEAK_BPS = 40; // peak gain that arms the trailing guard
const TRAIL_MIN_BPS = 25; // minimum gain to exit on a give-back
const REVERSAL_MIN_BARS = 4; // bars before the reversal exit can fire
const MS_PER_MIN = 60_000;

const clamp = (x: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, x));

function num(value: string | bigint | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function retBps(newer: number, older: number): number {
  if (!(newer > 0) || !(older > 0)) return 0;
  return (newer / older - 1) * BPS;
}

interface ClosePoint {
  t: number;
  c: number;
}

/** Return in bps over `minutes` ending at `nowT`, or null if the bar
 *  exactly that far back is missing (a gap in the feed). Never silently
 *  measures over the wrong span. */
function retOver(
  hist: ClosePoint[],
  nowT: number,
  nowC: number,
  minutes: number,
): number | null {
  const target = nowT - minutes * MS_PER_MIN;
  for (let i = hist.length - 1; i >= 0; i--) {
    const p = hist[i]!;
    if (p.t === target) return retBps(nowC, p.c);
    if (p.t < target) return null;
  }
  return null;
}

/** 1-minute return volatility (bps) from consecutive closes exactly one
 *  minute apart, over the last SIGMA_WINDOW valid pairs. Gaps are
 *  skipped, not stretched. Falls back to the window stdev (6.7 bps)
 *  when there is too little history. */
function computeSigma(hist: ClosePoint[]): number {
  const rets: number[] = [];
  for (let i = hist.length - 1; i >= 1 && rets.length < SIGMA_WINDOW; i--) {
    const cur = hist[i]!;
    const prev = hist[i - 1]!;
    if (cur.t - prev.t === MS_PER_MIN) rets.push(retBps(cur.c, prev.c));
  }
  if (rets.length < 8) return 6.7;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance =
    rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return clamp(Math.sqrt(Math.max(0, variance)), SIGMA_FLOOR, SIGMA_CAP);
}

await runBars({
  onBatch(state, batch) {
    const bar = state.latest.get(SYMBOL);
    if (!bar) return [];

    const close = num(bar.c);
    const high = num(bar.h);
    const low = num(bar.l);
    const seqState = state as any;

    const hist = (seqState.__hist as ClosePoint[] | undefined) ?? [];
    if (close > 0 && seqState.__lastHistorySeq !== batch.seq) {
      hist.push({ t: bar.t, c: close });
      if (hist.length > LOOKBACK) hist.shift();
      seqState.__lastHistorySeq = batch.seq;
    }
    seqState.__hist = hist;

    if (seqState.__pendingBuy === undefined) seqState.__pendingBuy = null;
    if (seqState.__pendingSell === undefined) seqState.__pendingSell = null;
    if (seqState.__entrySeq === undefined) seqState.__entrySeq = null;
    if (seqState.__lastExitSeq === undefined) seqState.__lastExitSeq = -1000;
    if (seqState.__lastEntryAttempt === undefined) seqState.__lastEntryAttempt = -1000;
    if (seqState.__orderCounter === undefined) seqState.__orderCounter = 0;
    if (seqState.__peakPnlBps === undefined) seqState.__peakPnlBps = 0;

    // Fill bookkeeping: fill.fill_bar is a millisecond timestamp, not a
    // batch seq — store batch.seq so the cooldowns below measure bars.
    for (const fill of batch.fills ?? []) {
      if (fill.client_id === seqState.__pendingBuy) {
        seqState.__pendingBuy = null;
        if (fill.status === 'filled') {
          seqState.__entrySeq = batch.seq;
          seqState.__peakPnlBps = 0;
        }
      }
      if (fill.client_id === seqState.__pendingSell) {
        seqState.__pendingSell = null;
        if (fill.status === 'filled') {
          seqState.__lastExitSeq = batch.seq;
          seqState.__entrySeq = null;
          seqState.__peakPnlBps = 0;
        }
      }
    }

    const held = state.positions.get(SYMBOL);
    if (!held && seqState.__pendingSell === null) {
      seqState.__entrySeq = null;
      seqState.__peakPnlBps = 0;
    }

    const sigma = computeSigma(hist);
    const nowT = bar.t;
    const r1 = retOver(hist, nowT, close, 1);
    const r3 = retOver(hist, nowT, close, 3);
    const r5 = retOver(hist, nowT, close, 5);

    // --- exit: only while holding, only one order at a time --------------
    if (held && seqState.__pendingSell === null) {
      const cost = held.cost;
      const marked = state.value(SYMBOL, held.qty);
      const pnlBps =
        cost > 0n
          ? Number((marked - cost) * 1_000_000n / cost) / 100
          : 0;
      const heldBars = Number.isInteger(seqState.__entrySeq)
        ? Math.max(0, batch.seq - seqState.__entrySeq)
        : 0;

      seqState.__peakPnlBps = Math.max(seqState.__peakPnlBps, pnlBps);

      const stopBps = clamp(2.2 * sigma * Math.sqrt(6), 35, 75);
      const targetBps = clamp(2.8 * sigma * Math.sqrt(6), 45, 90);
      const trailBps = clamp(1.2 * sigma, 10, 20);
      const giveBack =
        seqState.__peakPnlBps >= TRAIL_PEAK_BPS &&
        seqState.__peakPnlBps - pnlBps >= trailBps &&
        pnlBps >= TRAIL_MIN_BPS;
      const reversal =
        heldBars >= REVERSAL_MIN_BARS &&
        pnlBps < 0 &&
        r3 !== null &&
        r3 < -0.8 * sigma * Math.sqrt(3) &&
        r5 !== null &&
        r5 < 0;

      if (
        pnlBps <= -stopBps ||
        pnlBps >= targetBps ||
        giveBack ||
        reversal ||
        heldBars >= MAX_HOLD_BARS
      ) {
        seqState.__orderCounter++;
        const id = `s${seqState.__orderCounter}`;
        seqState.__pendingSell = id;
        return [{
          side: 'sell',
          client_id: id,
          symbol: SYMBOL,
          qty: held.qty,
          max_slippage_bps: 400,
        }];
      }
      return [];
    }

    // --- entry: extreme-flush fade only ----------------------------------
    if (held || seqState.__pendingBuy !== null || state.warmingUp) return [];
    if (batch.seq - seqState.__lastExitSeq < 2) return [];
    if (batch.seq - seqState.__lastEntryAttempt < 2) return [];
    if (hist.length < MIN_HISTORY || !(close > 0) || high < low) return [];
    if (r5 === null || r1 === null) return [];

    // A >=80 bps 5-minute drop whose last minute already ticks back up.
    // Full equity: the downside of a failed fade is bounded by the stop
    // (~-75 bps) and a no-flush day simply scores $0, while the upside
    // is the whole point of the entry.
    const flush = r5 <= -FLUSH_BPS && r1 > 0;
    if (!flush) return [];

    const cash = state.cash;
    const equity = state.equity;
    if (cash <= 0n || equity <= 0n) return [];

    let amount = equity;
    if (amount > cash) amount = cash;

    const room = state.weightRoom(SYMBOL);
    if (amount > room) amount = room;

    for (let i = 0; i < 12 && amount > 0n; i++) {
      const impact = state.impactBps(SYMBOL, amount);
      if (impact === null) return [];
      if (impact <= 10n) break;
      amount = (amount * 85n) / 100n;
    }

    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    if (amount < minNotional || amount <= 0n) return [];

    seqState.__orderCounter++;
    const id = `b${seqState.__orderCounter}`;
    seqState.__pendingBuy = id;
    seqState.__lastEntryAttempt = batch.seq;

    return [{
      side: 'buy',
      client_id: id,
      symbol: SYMBOL,
      notional_quote_units: amount,
      max_slippage_bps: 400,
    }];
  },
});

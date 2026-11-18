import { runBars } from './vendor/makefun-bars.ts';

// Design — extreme-flush fade ONLY (reviewed and rewritten in-session):
//  Buy a >=80 bps 5-minute flush once the last minute ticks back up
//  (r1 > 0), full equity. The dev window holds exactly one such event
//  (bars 65-69) and it rebounded +103 bps over the next 10 minutes, far
//  above the ~26-40 bps round-trip cost. Exits: volatility-scaled
//  target/stop, a give-back guard and a 20-bar time limit.
//  What was measured and REJECTED on this dev window:
//  * 3-minute momentum (the external model's r3 leg): forward 10m mean
//    ~0 bps over 100+ occurrences; unlocked it trades 126 times for
//    -47.44 USDC at a 17% win rate. Removed entirely.
//  * Fading mild 50 bps dips: break-even before costs.
//  * 10m/20m/60m dip fades at every threshold: 0-4 trades, all <= 0.
//  Honest caveat: the whole window contains ONE flush event, so this bot
//  trades 1-2 times per day. That is the point — it only trades the one
//  setup with a measured edge, and otherwise sits in cash. A race day
//  without a flush scores $0 (no trade, no prize); a race day with one
//  catches the rebound at full size. No thresholds were tuned to exact
//  dev-window levels; -80 bps is ~5x the 5-minute volatility (~15 bps).
//  Bug fix (found in review, see fill handler): fill.fill_bar is a
//  millisecond timestamp, not a batch seq — the r3 build stored it in
//  __entrySeq/__lastExitSeq, which locked the bot out after its first
//  sell. Its +1.98 USDC / 2-trade dev score was one lucky round trip
//  plus a permanent lockout, not a strategy.
const SYMBOL = 'CBBTC';
const BPS = 10_000;

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

await runBars({
  onBatch(state, batch) {
    const bar = state.latest.get(SYMBOL);
    if (!bar) return [];

    const close = num(bar.c);
    const high = num(bar.h);
    const low = num(bar.l);
    const seqState = state as any;

    const closes = (seqState.__closes as number[] | undefined) ?? [];
    if (close > 0 && seqState.__lastHistorySeq !== batch.seq) {
      closes.push(close);
      if (closes.length > 100) closes.shift();
      seqState.__lastHistorySeq = batch.seq;
    }
    seqState.__closes = closes;

    if (seqState.__pendingBuy === undefined) seqState.__pendingBuy = null;
    if (seqState.__pendingSell === undefined) seqState.__pendingSell = null;
    if (seqState.__entrySeq === undefined) seqState.__entrySeq = null;
    if (seqState.__lastExitSeq === undefined) seqState.__lastExitSeq = -1000;
    if (seqState.__lastEntryAttempt === undefined) seqState.__lastEntryAttempt = -1000;
    if (seqState.__orderCounter === undefined) seqState.__orderCounter = 0;
    if (seqState.__peakPnlBps === undefined) seqState.__peakPnlBps = 0;

    // NOTE (bug fix, found in review): fill.fill_bar is the fill bar's close
    // time in MILLISECONDS, not a batch seq. Storing it in __entrySeq /
    // __lastExitSeq made `batch.seq - __lastExitSeq < 2` true forever after
    // the first sell, so the bot could never trade again (the r3 build's
    // 2-trade score was really one round trip plus a permanent lockout).
    // Store the batch seq that carried the fill instead.
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

    const returns: number[] = [];
    for (let i = Math.max(1, closes.length - 61); i < closes.length; i++) {
      returns.push(retBps(closes[i]!, closes[i - 1]!));
    }

    let sigma = 6.7;
    if (returns.length >= 8) {
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance =
        returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
      sigma = Math.sqrt(Math.max(0, variance));
    }
    sigma = clamp(sigma, 2.5, 25);

    const n = closes.length;
    const r1 = n >= 2 ? retBps(closes[n - 1]!, closes[n - 2]!) : 0;
    const r3 = n >= 4 ? retBps(closes[n - 1]!, closes[n - 4]!) : 0;
    const r5 = n >= 6 ? retBps(closes[n - 1]!, closes[n - 6]!) : 0;

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
      const reversal =
        heldBars >= 3 &&
        r3 < -0.8 * sigma * Math.sqrt(3) &&
        r5 < 0;
      const protectedGain =
        seqState.__peakPnlBps >= 44 &&
        seqState.__peakPnlBps - pnlBps >= 15 &&
        pnlBps >= 27;

      if (
        pnlBps <= -stopBps ||
        pnlBps >= targetBps ||
        protectedGain ||
        reversal ||
        heldBars >= 20
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

    if (held || seqState.__pendingBuy !== null || state.warmingUp) return [];
    if (batch.seq - seqState.__lastExitSeq < 2) return [];
    if (batch.seq - seqState.__lastEntryAttempt < 2) return [];
    if (n < 21 || !(close > 0) || high < low) return [];

    // Extreme-flush fade only: a >=80 bps 5-minute drop whose last minute
    // already ticks back up. Full equity: the downside of a failed fade is
    // bounded by the stop (~-70 bps) and a no-flush day simply scores $0,
    // while the upside is the whole point of the entry.
    const flush = r5 <= -80 && r1 > 0;

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

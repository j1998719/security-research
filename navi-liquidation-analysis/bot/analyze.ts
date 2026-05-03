/**
 * NAVI Liquidation Analysis System
 *
 * Usage:
 *   npx tsx analyze.ts                        # market overview (last 500 events)
 *   npx tsx analyze.ts --days 7               # all events in last N days + liquidator summary
 *   npx tsx analyze.ts --date 2026-04-29      # all events on a specific day
 *   npx tsx analyze.ts --last 50              # most recent N events + liquidator summary
 *   npx tsx analyze.ts --gas                  # flash vs direct gas detail
 */

import { readFileSync } from "fs";
try { for (const line of readFileSync(new URL(".env", import.meta.url), "utf8").split("\n")) { const [k, v] = line.split("="); if (k?.trim() && v?.trim()) process.env[k.trim()] ??= v.trim(); } } catch {}

import { SuiClient } from "@mysten/sui/client";
import { tg }        from "./telegram.js";
import { ASSETS }    from "./config.js";
import { MAINNET }   from "./network.js";

// ── CLI args ──────────────────────────────────────────────────────────────────

const argv       = process.argv.slice(2);
const MODE_DAYS  = argv.includes("--days") ? Number(argv[argv.indexOf("--days") + 1]) : 0;
const MODE_DATE  = argv.includes("--date") ? argv[argv.indexOf("--date") + 1] : "";
const MODE_FROM  = argv.includes("--from") ? argv[argv.indexOf("--from") + 1] : "";
const MODE_TO    = argv.includes("--to")   ? argv[argv.indexOf("--to")   + 1] : "";
const MODE_LAST  = argv.includes("--last") ? Number(argv[argv.indexOf("--last") + 1]) : 0;
const MODE_GAS   = argv.includes("--gas");
const SCAN_LIMIT = Number(process.env.SCAN_LIMIT ?? "500");

// ── timezone ──────────────────────────────────────────────────────────────────

const TZ_OFFSET_MS = 8 * 3600 * 1000; // UTC+8

const localDate = (ts: number) => new Date(ts + TZ_OFFSET_MS).toISOString().slice(0, 10);
const localTime = (ts: number) => new Date(ts + TZ_OFFSET_MS).toISOString().slice(11, 19);
const localHour = (ts: number) => Math.floor(((ts + TZ_OFFSET_MS) / 3600_000) % 24);

// Parse a YYYY-MM-DD string as UTC+8 day boundaries → returns [startMs, endMs] in UTC
const parseDateRange = (d: string): [number, number] => [
  new Date(d + "T00:00:00+08:00").getTime(),
  new Date(d + "T23:59:59+08:00").getTime(),
];

// ── constants ─────────────────────────────────────────────────────────────────

const client   = new SuiClient({ url: MAINNET.SUI_RPC });
const NAVI_PKG = MAINNET.NAVI_PKG;

const PRICE_RANGE: Record<number, [number, number]> = {
  0:  [0.05,   20],       // SUI
  1:  [0.8,    1.2],      // USDC (bridged)
  2:  [0.8,    1.2],      // USDT (bridged)
  3:  [500,    20000],    // WETH (bridged)
  4:  [0.001,  2],        // CETUS
  5:  [0.05,   20],       // vSUI
  6:  [0.05,   20],       // haSUI
  7:  [0.001,  5],        // NAVX
  8:  [10000,  300000],   // WBTC (bridged BTC)
  9:  [0.8,    1.2],      // AUSD
  10: [0.8,    1.2],      // USDC (native)
  11: [500,    20000],    // ETH (native)
  12: [0.95,   1.15],     // USDY (Ondo yield dollar)
  13: [0.05,   10],       // NS (SuiNS token)
  14: [30000,  200000],   // BTC2 (wormhole bridged BTC)
  15: [0.001,  2],        // DEEP (DeepBook)
  16: [0.8,    1.2],      // FDUSD2
  17: [0.001,  5],        // BLUE
  18: [0.8,    1.2],      // BUCK
  19: [0.8,    1.2],      // USDT (native)
  20: [0.05,   20],       // stSUI
  21: [10000,  300000],   // BTC
  22: [0.001,  1000],     // a22 (unknown)
  23: [30000,  200000],   // LBTC (Lombard BTC)
  24: [0.05,   20],       // WAL
  25: [0.001,  10],       // HAEDAL
  26: [10000,  300000],   // XBTC
  27: [0.001,  10],       // IKA
  29: [10000,  300000],   // MBTC
  30: [10000,  300000],   // YBTC
};

// ── shared types ──────────────────────────────────────────────────────────────

interface LiqEvent {
  txDigest:    string;
  ts:          number;
  date:        string;   // YYYY-MM-DD
  time:        string;   // HH:MM:SS UTC
  liquidator:  string;
  borrower:    string;
  collatAsset: number;
  debtAsset:   number;
  collatUsd:   number;
  debtUsd:     number;
  collatAmt:   bigint;   // raw collateral amount (tokenDec units)
  debtAmt:     bigint;   // raw debt amount (tokenDec units)
  debtDec:     number;
  treasury:    bigint;
  collatPrice: bigint;
  collatDec:   number;
  bonusPct:    number;
  valid:       boolean;
}

interface TxMeta {
  gasSui:    number;
  gasPrice:  number;
  gasBudget: number;
  txBytes:   number;
  usesFlash: boolean;
}

interface ReserveCfg {
  ltv:          number;   // fraction 0-1
  liqThreshold: number;   // fraction 0-1
  liqBonus:     number;   // fraction 0-1
}

interface LiqProfile {
  address:     string;
  count:       number;
  netProfit:   number;
  gasSui:      number;
  flashPct:    number;   // 0-100
  avgGasPrice: number;
  borrowers:   Set<string>;
  firstTs:     number;
  lastTs:      number;
}

// ── shared utilities ──────────────────────────────────────────────────────────

function detectPriceDec(raw: bigint, id: number): number {
  const r = PRICE_RANGE[id];
  if (!r) return 9;
  for (const d of [9, 6, 8, 7]) {
    const v = Number(raw) / 10 ** d;
    if (v >= r[0] && v <= r[1]) return d;
  }
  return 9;
}

const sym = (id: number) => ASSETS[id]?.symbol ?? `a${id}`;

const $ = (v: number) =>
  Math.abs(v) >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M`
: Math.abs(v) >= 1_000     ? `$${(v / 1_000).toFixed(1)}k`
: `$${v.toFixed(2)}`;

const sa  = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;
const pct = (n: number, d: number) => d > 0 ? `${((n / d) * 100).toFixed(0)}%` : "—";

function statsOf(arr: number[]) {
  if (!arr.length) return { n: 0, mean: 0, median: 0, p95: 0, min: 0, max: 0 };
  const s = [...arr].sort((a, b) => a - b);
  return {
    n:      s.length,
    mean:   s.reduce((a, b) => a + b, 0) / s.length,
    median: s[Math.floor(s.length * 0.5)],
    p95:    s[Math.floor(s.length * 0.95)],
    min:    s[0],
    max:    s.at(-1)!,
  };
}

// ── data fetching ─────────────────────────────────────────────────────────────

interface ScanOpts {
  limit?:   number;   // max events (applies when startMs not set)
  startMs?: number;   // scan back to this timestamp (inclusive)
  endMs?:   number;   // skip events after this timestamp
}

function parseEvent(ev: any): LiqEvent {
  const j = ev.parsedJson as any;
  const ts   = Number(ev.timestampMs ?? 0);
  const ca   = Number(j.collateral_asset), da = Number(j.debt_asset);
  const cAmt = BigInt(j.collateral_amount), dAmt = BigInt(j.debt_amount);
  const cP   = BigInt(j.collateral_price),  dP  = BigInt(j.debt_price);
  const treas= BigInt(j.treasury ?? 0);
  const cDec = ASSETS[ca]?.tokenDec ?? 9, dDec = ASSETS[da]?.tokenDec ?? 6;
  const cpD  = detectPriceDec(cP, ca),    dpD  = detectPriceDec(dP, da);
  const collatUsd = (Number(cAmt + treas) / 10 ** cDec) * (Number(cP) / 10 ** cpD);
  const debtUsd   = (Number(dAmt)          / 10 ** dDec) * (Number(dP) / 10 ** dpD);
  const bonusPct  = debtUsd > 0 ? (collatUsd / debtUsd - 1) * 100 : 0;
  const valid     = bonusPct >= 0.5 && bonusPct <= 30 && debtUsd > 0.001;
  return {
    txDigest: ev.id.txDigest, ts,
    date: localDate(ts),
    time: localTime(ts),
    liquidator: j.sender, borrower: j.user,
    collatAsset: ca, debtAsset: da,
    collatUsd, debtUsd,
    collatAmt: cAmt, debtAmt: dAmt, debtDec: dDec,
    treasury: treas, collatPrice: cP, collatDec: cDec,
    bonusPct, valid,
  };
}

async function scanEvents(opts: ScanOpts = {}): Promise<LiqEvent[]> {
  const limit  = opts.limit ?? SCAN_LIMIT;
  const events: LiqEvent[] = [];
  let cursor: any = null;
  let stop = false;

  process.stdout.write(
    opts.startMs
      ? `Scanning events since ${new Date(opts.startMs).toISOString().slice(0, 10)}...`
      : `Scanning last ${limit} events...`
  );

  while (!stop) {
    const res = await client.queryEvents({
      query: { MoveEventType: `${NAVI_PKG}::event::LiquidationEvent` },
      cursor, limit: 50, order: "descending",
    });

    for (const ev of res.data) {
      const ts = Number(ev.timestampMs ?? 0);
      if (opts.startMs && ts < opts.startMs) { stop = true; break; }
      if (opts.endMs && ts > opts.endMs) continue;
      events.push(parseEvent(ev));
      if (!opts.startMs && events.length >= limit) { stop = true; break; }
    }

    if (!stop) {
      if (res.hasNextPage && res.data.length > 0) cursor = res.nextCursor;
      else stop = true;
    }
    await new Promise(r => setTimeout(r, 80));
  }

  console.log(` ${events.length} events (${events.filter(e => e.valid).length} valid)`);
  return events;
}

async function fetchTxMeta(digests: string[]): Promise<Map<string, TxMeta>> {
  const meta   = new Map<string, TxMeta>();
  const unique = [...new Set(digests)];
  process.stdout.write(`Fetching TX metadata (${unique.length} TXs)...`);

  for (let i = 0; i < unique.length; i += 50) {
    const txs = await client.multiGetTransactionBlocks({
      digests: unique.slice(i, i + 50),
      options: { showInput: true, showEffects: true, showRawInput: true },
    }).catch(() => []);

    for (const tx of txs) {
      if (!tx?.digest) continue;
      const g       = tx.effects?.gasUsed;
      const mist    = g ? BigInt(g.computationCost ?? 0) + BigInt(g.storageCost ?? 0) - BigInt(g.storageRebate ?? 0) : 0n;
      const callStr = JSON.stringify((tx as any).transaction?.data?.transaction?.transactions ?? []);
      const rawBytes = (tx as any).rawTransaction?.length ?? 0;
      meta.set(tx.digest, {
        gasSui:    Number(mist) / 1e9,
        gasPrice:  Number((tx as any).transaction?.data?.gasData?.price  ?? 0),
        gasBudget: Number((tx as any).transaction?.data?.gasData?.budget ?? 0),
        txBytes:   Math.round(rawBytes * 3 / 4),
        usesFlash: callStr.includes("flash_swap") || callStr.includes("flash_loan"),
      });
    }
    await new Promise(r => setTimeout(r, 80));
  }

  console.log(" done");
  return meta;
}

// key: liqEvent.txDigest → timestamp of the most recent BorrowEvent for same asset before liq
async function fetchBorrowTimes(events: LiqEvent[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();

  // Group by borrower to minimize RPC calls
  const byBorrower = new Map<string, LiqEvent[]>();
  for (const ev of events) {
    const arr = byBorrower.get(ev.borrower) ?? [];
    arr.push(ev);
    byBorrower.set(ev.borrower, arr);
  }

  process.stdout.write(`Fetching borrow history (${byBorrower.size} borrowers)...`);

  for (const [borrower, liqEvs] of byBorrower) {
    const minLiqTs = Math.min(...liqEvs.map(e => e.ts));
    const collected: { ts: number; asset: number }[] = [];
    let cursor: any = null;
    let stop = false;

    let pages = 0;
    while (!stop) {
      const res = await client.queryEvents({
        query: { Sender: borrower },
        cursor, limit: 50, order: "descending",
      }).catch(() => ({ data: [] as any[], hasNextPage: false, nextCursor: null }));
      pages++;

      for (const ev of res.data) {
        const ts = Number(ev.timestampMs ?? 0);
        if (ts < minLiqTs - 1825 * 86_400_000) { stop = true; break; } // look back max 5 years
        if (ev.type?.split("::").pop() !== "BorrowEvent") continue;
        const j   = ev.parsedJson as any;
        const aid = j.market_id != null ? Number(j.market_id) : Number(j.reserve);
        collected.push({ ts, asset: aid });
      }

      if ((res as any).hasNextPage && res.data.length > 0 && pages < 50) cursor = (res as any).nextCursor;
      else stop = true;
      await new Promise(r => setTimeout(r, 60));
    }

    for (const liqEv of liqEvs) {
      const match = collected
        .filter(b => b.asset === liqEv.debtAsset && b.ts <= liqEv.ts)
        .sort((a, b) => b.ts - a.ts)[0];
      if (match) result.set(liqEv.txDigest, match.ts);
    }
  }

  console.log(" done");
  return result;
}

const RAY_BIG = BigInt("1000000000000000000000000000");

async function loadReserveCfgs(): Promise<Map<number, ReserveCfg>> {
  const cfgs = new Map<number, ReserveCfg>();
  try {
    process.stdout.write("Loading reserve configs...");
    const storage = await client.getObject({
      id: MAINNET.NAVI_STORAGE.id,
      options: { showContent: true },
    });
    const sf = (storage.data as any)?.content?.fields;
    const reservesId: string | undefined =
      sf?.reserves?.fields?.id?.id ?? sf?.reserves?.id?.id ?? sf?.reserves?.id;
    if (!reservesId) { console.log(" (no reserves table found)"); return cfgs; }

    let cursor: any = null;
    const dynFields: any[] = [];
    while (true) {
      const page = await client.getDynamicFields({ parentId: reservesId, cursor, limit: 50 });
      dynFields.push(...page.data);
      if (!page.hasNextPage) break;
      cursor = page.nextCursor;
      await new Promise(r => setTimeout(r, 60));
    }

    const toFrac = (v: string | number) =>
      Number(BigInt(String(v)) * 10_000n / RAY_BIG) / 10_000;

    for (let i = 0; i < dynFields.length; i += 10) {
      const batch = dynFields.slice(i, i + 10);
      const objs  = await client.multiGetObjects({
        ids: batch.map(f => f.objectId),
        options: { showContent: true },
      }).catch(() => []);

      for (const obj of objs) {
        const f = (obj.data as any)?.content?.fields;
        if (!f) continue;
        const assetId = Number(f.name ?? (f.id && batch.find((b: any) => b.objectId === obj.data?.objectId)?.name?.value));
        const val     = f.value?.fields ?? f.value;
        if (!val) continue;
        const lf      = val.liquidation_factors?.fields ?? val.liquidation_factors;
        const ltv     = val.ltv;
        if (ltv == null || !lf) continue;
        cfgs.set(assetId, {
          ltv:          toFrac(ltv),
          liqThreshold: toFrac(lf.threshold),
          liqBonus:     toFrac(lf.bonus),
        });
      }
      await new Promise(r => setTimeout(r, 60));
    }
    console.log(` ${cfgs.size} reserves`);
  } catch (e) {
    console.log(` failed (${e})`);
  }
  return cfgs;
}

function fmtDuration(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}


function buildProfiles(events: LiqEvent[], meta: Map<string, TxMeta>): LiqProfile[] {
  const byAddr = new Map<string, LiqProfile>();

  for (const ev of events) {
    const txm = meta.get(ev.txDigest);
    let p = byAddr.get(ev.liquidator);
    if (!p) {
      p = { address: ev.liquidator, count: 0, netProfit: 0, gasSui: 0,
            flashPct: 0, avgGasPrice: 0, borrowers: new Set(),
            firstTs: ev.ts, lastTs: ev.ts };
      byAddr.set(ev.liquidator, p);
    }
    p.count++;
    p.borrowers.add(ev.borrower);
    p.gasSui      += txm?.gasSui ?? 0;
    p.avgGasPrice += txm?.gasPrice ?? 0;
    if (txm?.usesFlash) p.flashPct++;
    if (ev.valid) {
      const treasUsd = (Number(ev.treasury) / 10 ** ev.collatDec)
                     * (Number(ev.collatPrice) / 10 ** detectPriceDec(ev.collatPrice, ev.collatAsset));
      p.netProfit += ev.collatUsd - ev.debtUsd - treasUsd;
    }
    if (ev.ts < p.firstTs) p.firstTs = ev.ts;
    if (ev.ts > p.lastTs)  p.lastTs  = ev.ts;
  }

  for (const p of byAddr.values()) {
    p.avgGasPrice = p.count > 0 ? Math.round(p.avgGasPrice / p.count) : 0;
    p.flashPct    = p.count > 0 ? Math.round(p.flashPct / p.count * 100) : 0;
  }

  return [...byAddr.values()].sort((a, b) => b.count - a.count);
}

// ── Market overview sections ──────────────────────────────────────────────────

function secOverview(events: LiqEvent[], profiles: LiqProfile[], meta: Map<string, TxMeta>): string {
  const valid    = events.filter(e => e.valid);
  const n        = events.length;
  const oldestTs = Math.min(...events.map(e => e.ts));
  const newestTs = Math.max(...events.map(e => e.ts));
  const spanDays = (newestTs - oldestTs) / 86_400_000;
  const flashTxs = [...meta.values()].filter(m => m.usesFlash).length;
  const hhi      = profiles.reduce((s, p) => s + (p.count / n) ** 2, 0) * 10_000;
  const top3cnt  = profiles.slice(0, 3).reduce((s, p) => s + p.count, 0);
  const totalCollat = valid.reduce((s, e) => s + e.collatUsd, 0);
  const totalDebt   = valid.reduce((s, e) => s + e.debtUsd, 0);
  const medBonus    = valid.map(e => e.bonusPct).sort((a, b) => a - b)[Math.floor(valid.length / 2)] ?? 0;
  const totalGas    = profiles.reduce((s, p) => s + p.gasSui, 0);

  let m = `📊 <b>NAVI Liquidation Market</b>\n`;
  m += `${localDate(oldestTs)} → ${localDate(newestTs)} (UTC+8)\n\n`;
  m += `<b>Volume</b>\n`;
  m += `  ${n} liquidations · ${profiles.length} liquidators · ${(n / spanDays).toFixed(1)}/day\n`;
  m += `  Valid: ${valid.length}/${n} (${pct(valid.length, n)})\n\n`;
  m += `<b>Economics (valid)</b>\n`;
  m += `  Collateral seized: ${$(totalCollat)}\n`;
  m += `  Debt repaid:       ${$(totalDebt)}\n`;
  m += `  Gross profit:      ${$(totalCollat - totalDebt)}\n`;
  m += `  Median bonus:      ${medBonus.toFixed(1)}%   Gas total: ${totalGas.toFixed(1)} SUI\n\n`;
  m += `<b>Concentration  HHI=${hhi.toFixed(0)} (${hhi > 2500 ? "High" : hhi > 1500 ? "Moderate" : "Low"})</b>\n`;
  m += `  Top-3 share: ${pct(top3cnt, n)}   Flash: ${pct(flashTxs, meta.size)}\n`;
  return m;
}

function secLeaderboard(profiles: LiqProfile[], total: number): string {
  let m = `🏆 <b>Liquidator Leaderboard</b>\n\n`;
  m += `<code>#  addr             cnt   net$    avg$   fl%  gas(SUI)</code>\n`;
  for (let i = 0; i < Math.min(10, profiles.length); i++) {
    const p = profiles[i];
    m += `<code>${String(i + 1).padStart(2)} ${sa(p.address).padEnd(16)} ${String(p.count).padStart(3)} ${$(p.netProfit).padStart(7)} ${$(p.netProfit / p.count).padStart(6)} ${String(p.flashPct).padStart(2)}% ${p.gasSui.toFixed(2).padStart(8)}</code>\n`;
  }
  const topProfit = [...profiles].sort((a, b) => b.netProfit - a.netProfit)[0];
  if (topProfit)
    m += `\n💵 Most profitable: <code>${sa(topProfit.address)}</code>  ${$(topProfit.netProfit)} / ${topProfit.count}× = ${$(topProfit.netProfit / topProfit.count)}/liq\n`;
  return m;
}

function secStrategy(events: LiqEvent[], profiles: LiqProfile[], meta: Map<string, TxMeta>, includeGas: boolean): string {
  const n         = events.length;
  const flashTxs  = [...meta.values()].filter(m => m.usesFlash).length;
  const flashBots = profiles.filter(p => p.flashPct >= 80);
  const directBots= profiles.filter(p => p.flashPct < 20);
  const hybridBots= profiles.filter(p => p.flashPct >= 20 && p.flashPct < 80);
  const gasPrices = [...meta.values()].map(m => m.gasPrice).filter(p => p > 0).sort((a, b) => a - b);
  const hourBuckets = new Array(24).fill(0);
  for (const ev of events) hourBuckets[localHour(ev.ts)]++;
  const maxH  = Math.max(...hourBuckets);
  const peak3 = [...hourBuckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h]) => `${h}:00`).join(", ");
  const barStr = Array.from({ length: 24 }, (_, h) =>
    hourBuckets[h] >= maxH * 0.7 ? "▓" : hourBuckets[h] > 0 ? "░" : "·"
  ).join("");

  let m = `⚙️ <b>Strategy Analysis</b>\n\n`;
  m += `<b>Flash Swap Usage</b>  ${pct(flashTxs, meta.size)}\n`;
  m += `  Capital-light (≥80%): ${flashBots.length}  (${pct(flashBots.reduce((s, p) => s + p.count, 0), n)} vol)\n`;
  m += `  Direct (&lt;20%):     ${directBots.length}  (${pct(directBots.reduce((s, p) => s + p.count, 0), n)} vol)\n`;
  m += `  Hybrid:              ${hybridBots.length}\n\n`;

  m += `<b>Gas Pricing  (no mempool → latency wins, not gas)</b>\n`;
  const gp50 = gasPrices[Math.floor(gasPrices.length * 0.5)] ?? 0;
  const gp95 = gasPrices[Math.floor(gasPrices.length * 0.95)] ?? 0;
  m += `  p50: ${gp50} MIST   p95: ${gp95} MIST\n\n`;

  if (includeGas) {
    const flashGas  = [...meta.entries()].filter(([, m]) =>  m.usesFlash).map(([, m]) => m.gasSui);
    const directGas = [...meta.entries()].filter(([, m]) => !m.usesFlash).map(([, m]) => m.gasSui);
    const flashBytes  = [...meta.entries()].filter(([, m]) =>  m.usesFlash).map(([, m]) => m.txBytes);
    const directBytes = [...meta.entries()].filter(([, m]) => !m.usesFlash).map(([, m]) => m.txBytes);
    const sf = statsOf(flashGas), sd = statsOf(directGas);
    const sbf = statsOf(flashBytes), sbd = statsOf(directBytes);
    m += `<b>Flash vs Direct Gas Cost</b>\n`;
    m += `<code>           flash     direct</code>\n`;
    m += `<code>n:         ${String(sf.n).padStart(5)}    ${String(sd.n).padStart(5)}</code>\n`;
    m += `<code>median:  ${sf.median.toFixed(4).padStart(8)}  ${sd.median.toFixed(4).padStart(8)} SUI</code>\n`;
    m += `<code>p95:     ${sf.p95.toFixed(4).padStart(8)}  ${sd.p95.toFixed(4).padStart(8)} SUI</code>\n`;
    if (sd.median > 0) m += `Flash median = ${(sf.median / sd.median).toFixed(2)}× direct\n`;
    m += `<code>tx size: ${String(sbf.median).padStart(7)}B   ${String(sbd.median).padStart(7)}B</code>\n\n`;
  }

  m += `<b>Activity Pattern (UTC)</b>  Peak: ${peak3}\n`;
  m += `  <code>00              12              23</code>\n`;
  m += `  <code>${barStr}</code>\n`;
  return m;
}

function secOpportunity(events: LiqEvent[], profiles: LiqProfile[]): string {
  const valid  = events.filter(e => e.valid);
  const n      = events.length;
  const oldest = Math.min(...events.map(e => e.ts));
  const newest = Math.max(...events.map(e => e.ts));
  const spanDays = (newest - oldest) / 86_400_000;
  const hhi    = profiles.reduce((s, p) => s + (p.count / n) ** 2, 0) * 10_000;

  const pairMap = new Map<string, { cnt: number; profit: number }>();
  for (const ev of valid) {
    const k = `${sym(ev.debtAsset)}→${sym(ev.collatAsset)}`;
    const e = pairMap.get(k) ?? { cnt: 0, profit: 0 };
    e.cnt++;
    e.profit += ev.collatUsd - ev.debtUsd;
    pairMap.set(k, e);
  }
  const topPairs = [...pairMap.entries()].sort((a, b) => b[1].cnt - a[1].cnt).slice(0, 6);

  const borrowerHits = new Map<string, number>();
  for (const ev of events) borrowerHits.set(ev.borrower, (borrowerHits.get(ev.borrower) ?? 0) + 1);
  const multiLiq = [...borrowerHits.values()].filter(c => c > 1).length;
  const unique   = borrowerHits.size;

  const avgPerBot    = ((n / spanDays) / profiles.length).toFixed(1);
  const profPositive = profiles.filter(p => p.netProfit > 0).length;
  const score        = Math.min(10, Math.round((1 - hhi / 10_000) * 10 + profPositive * 0.5));

  let m = `🎯 <b>Opportunity Assessment</b>\n\n`;
  m += `<b>Top Pairs (debt→collateral)</b>\n`;
  for (const [pair, { cnt, profit }] of topPairs)
    m += `  ${pair.padEnd(14)} ${String(cnt).padStart(3)}×  avg ${$(profit / cnt)}\n`;
  m += `\n`;
  m += `<b>Borrower Behavior</b>\n`;
  m += `  Unique: ${unique}   Re-liquidated: ${multiLiq} (${pct(multiLiq, unique)})\n\n`;
  m += `<b>Competition</b>\n`;
  m += `  Avg liq/bot/day: ${avgPerBot}   Profitable bots: ${profPositive}/${profiles.length}\n`;
  m += `  Opportunity score: ${"⭐".repeat(score)}${"☆".repeat(10 - score)} (${score}/10)\n\n`;
  m += `<b>Entry Requirement</b>\n`;
  if (hhi > 2500) {
    m += `  ⚠️ Concentrated — top bot ${profiles[0]?.count}× vs avg ${(n / profiles.length).toFixed(0)}×\n`;
    m += `  Flash swap + faster detection required\n`;
  } else {
    m += `  ✅ Fragmented — tail opportunities exist\n`;
    m += `  Direct liquidation (no flash) viable for small positions\n`;
  }
  return m;
}

// ── Liquidator summary ────────────────────────────────────────────────────────

function secLiquidatorSummary(events: LiqEvent[], meta: Map<string, TxMeta>): string {
  const byAddr = new Map<string, { count: number; profit: number; gasMist: number; flash: number }>();

  for (const ev of events) {
    const txm = meta.get(ev.txDigest);
    let p = byAddr.get(ev.liquidator);
    if (!p) { p = { count: 0, profit: 0, gasMist: 0, flash: 0 }; byAddr.set(ev.liquidator, p); }
    p.count++;
    if (ev.valid) p.profit += ev.collatUsd - ev.debtUsd;
    if (txm) { p.gasMist += Math.round(txm.gasSui * 1e9); if (txm.usesFlash) p.flash++; }
  }

  const suiPrice = extractSuiPrice(events);
  const ranked   = [...byAddr.entries()].sort((a, b) => b[1].profit - a[1].profit);

  let m = `📋 <b>Liquidator Summary</b>\n\n`;
  m += `<code>addr        cnt   profit    gas(SUI)  gas(USD)  flash%</code>\n`;
  for (const [addr, p] of ranked) {
    const gasSui   = p.gasMist / 1e9;
    const gasUsd   = suiPrice > 0 ? gasSui * suiPrice : null;
    const gasUsdStr= gasUsd != null ? $(gasUsd).padStart(8) : "       —";
    const flashPct = p.count > 0 ? Math.round(p.flash / p.count * 100) : 0;
    m += `<code>${addr.slice(0, 10)}  ${String(p.count).padStart(3)}  ${$(p.profit).padStart(9)}  ${gasSui.toFixed(4).padStart(8)}  ${gasUsdStr}  ${`${flashPct}%`.padStart(5)}</code>\n`;
  }
  return m;
}

// ── Per-event listing ─────────────────────────────────────────────────────────

// Extract SUI price from same-day events (used for gas USD estimate)
function extractSuiPrice(events: LiqEvent[]): number {
  for (const ev of events) {
    if (ev.collatAsset === 0) {
      const d = detectPriceDec(ev.collatPrice, 0);
      const p = Number(ev.collatPrice) / 10 ** d;
      if (p > 0.1) return p;
    }
  }
  return 0;
}

// Card format — used by --date / --days / --last
function secEventList(events: LiqEvent[], meta: Map<string, TxMeta>, label: string, borrowTimes?: Map<string, number>, reserveCfgs?: Map<number, ReserveCfg>): string {
  if (events.length === 0) return `🔍 <b>Liquidations: ${label}</b>\n\nNo events found.\n`;

  const totalDebt   = events.reduce((s, e) => s + e.debtUsd, 0);
  const totalCollat = events.reduce((s, e) => s + e.collatUsd, 0);
  const flashCount  = [...meta.values()].filter(m => m.usesFlash).length;
  const suiPrice    = extractSuiPrice(events);

  let m = `🔍 <b>Liquidations: ${label}</b>  (UTC+8)\n`;
  m += `${events.length} events · debt ${$(totalDebt)} · collat ${$(totalCollat)} · profit ${$(totalCollat - totalDebt)} · flash ${flashCount}/${meta.size}\n\n`;

  for (let i = 0; i < events.length; i++) {
    const ev  = events[i];
    const txm = meta.get(ev.txDigest);
    const gasMist = txm ? Math.round(txm.gasSui * 1e9) : 0;
    const gasSui  = gasMist / 1e9;
    const gasUsd  = suiPrice > 0 ? gasSui * suiPrice : null;
    const profit  = ev.collatUsd - ev.debtUsd;
    const netProfit = gasUsd != null ? profit - gasUsd : null;

    const collatRaw = (Number(ev.collatAmt) / 10 ** ev.collatDec).toFixed(4);
    const debtRaw   = (Number(ev.debtAmt)   / 10 ** ev.debtDec).toFixed(4);
    const treasUsd  = ev.valid
      ? (Number(ev.treasury) / 10 ** ev.collatDec) * (Number(ev.collatPrice) / 10 ** detectPriceDec(ev.collatPrice, ev.collatAsset))
      : 0;
    const gasUsdStr    = gasUsd  != null ? ` = ${$(gasUsd)}`             : "";
    const netProfitStr = netProfit != null ? `  net ${$(netProfit)}` : "";
    const flashTag     = txm?.usesFlash ? "⚡flash" : "direct";
    const addr8        = (a: string) => a.slice(0, 10);

    const borrowTs  = borrowTimes?.get(ev.txDigest);
    const debtAgeStr = borrowTs != null
      ? `  debt age ${fmtDuration(ev.ts - borrowTs)}  (since ${localDate(borrowTs)} ${localTime(borrowTs).slice(0,5)})`
      : "";

    m += `<b>#${i + 1}  ${ev.date} ${ev.time}  ${flashTag}  ·  ${sym(ev.debtAsset)}→${sym(ev.collatAsset)}  ·  profit ${$(profit)}${netProfitStr}</b>\n`;
    m += `  Borrower   <code>${addr8(ev.borrower)}</code>  Liquidator <code>${addr8(ev.liquidator)}</code>${debtAgeStr}\n`;
    m += `  Debt    ${debtRaw.padStart(12)} ${sym(ev.debtAsset).padEnd(6)} ${$(ev.debtUsd).padStart(9)}\n`;
    m += `  Collat  ${collatRaw.padStart(12)} ${sym(ev.collatAsset).padEnd(6)} ${$(ev.collatUsd).padStart(9)}  bonus ${ev.bonusPct.toFixed(1)}%\n`;
    m += `  Treasury ${$(treasUsd)}\n`;

    // Protocol params: LT/LTV from collat reserve, HF estimate, fixed 50% close factor
    const rcCollat = reserveCfgs?.get(ev.collatAsset);
    if (rcCollat) {
      const lt  = (rcCollat.liqThreshold * 100).toFixed(1);
      const ltv = (rcCollat.ltv          * 100).toFixed(1);
      const hf  = ev.debtUsd > 0 ? (ev.collatUsd * rcCollat.liqThreshold / ev.debtUsd).toFixed(3) : "—";
      m += `  HF ≈${hf}  LT ${lt}%  LTV ${ltv}%  close 50%\n`;
    }

    m += `  Gas  ${gasMist.toLocaleString().padStart(13)} MIST · ${gasSui.toFixed(4)} SUI${gasUsdStr}  @${(txm?.gasPrice ?? 0).toLocaleString()}/unit\n`;
    m += `  TX <code>${ev.txDigest}</code>\n\n`;
  }
  return m;
}


// ── Day deep-dive sections (--date YYYY-MM-DD) — kept for reference ───────────

function secHourly(events: LiqEvent[], meta: Map<string, TxMeta>): string {
  const hours = new Map<number, { count: number; profit: number; liquidators: Set<string> }>();
  for (const ev of events) {
    const h = localHour(ev.ts);
    if (!hours.has(h)) hours.set(h, { count: 0, profit: 0, liquidators: new Set() });
    const b = hours.get(h)!;
    b.count++;
    b.liquidators.add(ev.liquidator);
    if (ev.valid) b.profit += ev.collatUsd - ev.debtUsd;
  }
  const maxH = Math.max(...[...hours.values()].map(h => h.count));

  let m = `🔍 <b>Deep Dive: ${MODE_DATE}</b>  (${events.length} liquidations)\n\n`;
  m += `<b>Hourly Activity (UTC+8)</b>\n`;
  for (let h = 0; h < 24; h++) {
    const b = hours.get(h);
    if (!b) continue;
    const barStr  = "█".repeat(Math.round(b.count / maxH * 12)).padEnd(12, "░");
    const profStr = b.profit > 0 ? $(b.profit) : "–";
    m += `<code>${String(h).padStart(2)}:00 ${barStr} ${String(b.count).padStart(3)}× ${profStr.padStart(8)}</code>\n`;
  }
  return m;
}

function secBigLiquidations(events: LiqEvent[], meta: Map<string, TxMeta>): string {
  const bigEvs = events.filter(e => e.valid && e.collatUsd - e.debtUsd > 50)
    .sort((a, b) => (b.collatUsd - b.debtUsd) - (a.collatUsd - a.debtUsd));

  let m = `💥 <b>Big Liquidations (>$50 profit)</b>\n`;
  if (bigEvs.length === 0) {
    m += "  None\n";
  } else {
    m += `<code>time     liquidator   debt→collat        profit</code>\n`;
    for (const ev of bigEvs.slice(0, 15)) {
      const pair = `${sym(ev.debtAsset)}→${sym(ev.collatAsset)}`.padEnd(12);
      const fl   = meta.get(ev.txDigest)?.usesFlash ? "⚡" : "  ";
      m += `<code>${ev.time} ${sa(ev.liquidator).padEnd(13)} ${pair} ${$(ev.collatUsd - ev.debtUsd).padStart(9)} ${fl}</code>\n`;
    }
  }
  return m;
}

function secBorrowerAnalysis(events: LiqEvent[], meta: Map<string, TxMeta>): string {
  const byBorrower = new Map<string, LiqEvent[]>();
  for (const ev of events) {
    const arr = byBorrower.get(ev.borrower) ?? [];
    arr.push(ev);
    byBorrower.set(ev.borrower, arr);
  }

  // Multi-hit borrowers
  const multiHit = [...byBorrower.entries()]
    .filter(([, evs]) => evs.length > 1)
    .sort((a, b) => b[1].reduce((s, e) => s + e.debtUsd, 0) - a[1].reduce((s, e) => s + e.debtUsd, 0));

  // Race conditions: same borrower, different bots, < 5 min
  interface Race { t1: string; t2: string; bot1: string; bot2: string; gapSec: number }
  const races: Race[] = [];
  for (const [, evs] of byBorrower) {
    const s = [...evs].sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < s.length - 1; i++) {
      const gap = s[i + 1].ts - s[i].ts;
      if (gap < 300_000 && s[i].liquidator !== s[i + 1].liquidator)
        races.push({ t1: s[i].time, t2: s[i + 1].time, bot1: s[i].liquidator, bot2: s[i + 1].liquidator, gapSec: Math.round(gap / 1000) });
    }
  }

  // Large borrowers (> $1k total debt)
  const bigBorrowers = [...byBorrower.entries()]
    .filter(([, evs]) => evs.reduce((s, e) => s + e.debtUsd, 0) > 1000)
    .sort((a, b) => b[1].reduce((s, e) => s + e.debtUsd, 0) - a[1].reduce((s, e) => s + e.debtUsd, 0));

  let m = `🔁 <b>Borrower Analysis: ${MODE_DATE}</b>\n\n`;

  m += `<b>Multi-hit borrowers</b>\n`;
  if (multiHit.length === 0) {
    m += "  None\n";
  } else {
    m += `<code>borrower         hits  total_debt  bots</code>\n`;
    for (const [borrower, evs] of multiHit.slice(0, 8)) {
      const totalDebt = evs.reduce((s, e) => s + e.debtUsd, 0);
      const bots = new Set(evs.map(e => e.liquidator)).size;
      const span = Math.round((evs.at(-1)!.ts - evs[0].ts) / 60_000);
      m += `<code>${sa(borrower)} ${String(evs.length).padStart(4)}  ${$(totalDebt).padStart(10)}  ${bots}bot ${span}min</code>\n`;
    }
  }
  m += `\n`;

  m += `<b>Race Conditions (&lt;5min, 2 bots)</b>\n`;
  if (races.length === 0) {
    m += "  No races\n";
  } else {
    for (const r of races)
      m += `  ${r.t1}→${r.t2} (${r.gapSec}s)  ${sa(r.bot1)} then ${sa(r.bot2)}\n`;
  }
  m += `\n`;

  if (bigBorrowers.length > 0) {
    m += `<b>Large Borrower Timeline (&gt;$1k debt)</b>\n`;
    for (const [borrower, evs] of bigBorrowers.slice(0, 3)) {
      const totalDebt = evs.reduce((s, e) => s + e.debtUsd, 0);
      m += `Borrower ${sa(borrower)} (${$(totalDebt)} total)\n`;
      for (const ev of [...evs].sort((a, b) => a.ts - b.ts)) {
        const fl = meta.get(ev.txDigest)?.usesFlash ? "⚡flash" : "direct";
        m += `  ${ev.time} ${sa(ev.liquidator)} ${$(ev.debtUsd)} ${sym(ev.debtAsset)} → ${$(ev.collatUsd - ev.debtUsd)} profit [${fl}]\n`;
      }
      m += `\n`;
    }
  }

  return m;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  let events: LiqEvent[];
  let sections: string[];

  if (MODE_FROM && MODE_TO) {
    const [rangeStart] = parseDateRange(MODE_FROM);
    const [, rangeEnd] = parseDateRange(MODE_TO);
    events = await scanEvents({ startMs: rangeStart, endMs: rangeEnd });
    events.sort((a, b) => a.ts - b.ts);
    const meta         = await fetchTxMeta(events.map(e => e.txDigest));
    const borrowTimes  = await fetchBorrowTimes(events);
    const reserveCfgs  = await loadReserveCfgs();
    sections = [secEventList(events, meta, `${MODE_FROM} ~ ${MODE_TO}`, borrowTimes, reserveCfgs), secLiquidatorSummary(events, meta)];

  } else if (MODE_DATE) {
    const [dayStart, dayEnd] = parseDateRange(MODE_DATE);
    events = await scanEvents({ startMs: dayStart, endMs: dayEnd });
    events.sort((a, b) => a.ts - b.ts);
    const meta         = await fetchTxMeta(events.map(e => e.txDigest));
    const borrowTimes  = await fetchBorrowTimes(events);
    const reserveCfgs  = await loadReserveCfgs();
    sections = [secEventList(events, meta, MODE_DATE, borrowTimes, reserveCfgs)];

  } else if (MODE_DAYS) {
    events = await scanEvents({ startMs: Date.now() - MODE_DAYS * 86_400_000 });
    events.sort((a, b) => a.ts - b.ts);
    const meta         = await fetchTxMeta(events.map(e => e.txDigest));
    const borrowTimes  = await fetchBorrowTimes(events);
    const reserveCfgs  = await loadReserveCfgs();
    sections = [secEventList(events, meta, `${MODE_DAYS}d`, borrowTimes, reserveCfgs), secLiquidatorSummary(events, meta)];

  } else if (MODE_LAST) {
    events = await scanEvents({ limit: MODE_LAST });
    events.sort((a, b) => a.ts - b.ts);
    const meta         = await fetchTxMeta(events.map(e => e.txDigest));
    const borrowTimes  = await fetchBorrowTimes(events);
    const reserveCfgs  = await loadReserveCfgs();
    sections = [secEventList(events, meta, `Last ${MODE_LAST} events`, borrowTimes, reserveCfgs), secLiquidatorSummary(events, meta)];

  } else {
    events = await scanEvents({ limit: SCAN_LIMIT });
    const meta     = await fetchTxMeta(events.map(e => e.txDigest));
    const profiles = buildProfiles(events, meta);
    sections = [
      secOverview(events, profiles, meta),
      secLeaderboard(profiles, events.length),
      secStrategy(events, profiles, meta, MODE_GAS),
      secOpportunity(events, profiles),
    ];
  }

  if (!events.length) { console.log("No events found."); return; }

  for (const sec of sections) {
    console.log("\n" + sec.replace(/<[^>]+>/g, ""));
    await tg(sec);
    await new Promise(r => setTimeout(r, 500));
  }
  console.log("\nDone.");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });

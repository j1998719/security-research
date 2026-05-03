/**
 * scan_wallet_opps.ts — Rescan positions cache with live prices, list all profitable opps
 * Usage: npx tsx scan_wallet_opps.ts
 */
import { readFileSync } from "fs";
try {
  for (const line of readFileSync(new URL(".env", import.meta.url), "utf8").split("\n")) {
    const [k, v] = line.split("=");
    if (k?.trim() && v?.trim()) process.env[k.trim()] ??= v.trim();
  }
} catch {}

import { SuiClient } from "@mysten/sui/client";
import { MAINNET } from "./network.js";
import {
  BotState, loadAssetConfigs, loadOraclePrices, reserveCache,
} from "./position-store.js";
import { ASSETS, RAY } from "./config.js";

const client = new SuiClient({ url: MAINNET.SUI_RPC });

async function main() {
  const state = new BotState();
  await loadAssetConfigs(state, client, MAINNET);
  state.loadCetusFees(MAINNET.CETUS_POOLS);

  const feedToAssets = new Map<string, number[]>();
  for (const [id, a] of Object.entries(ASSETS)) {
    if (!a.pyth) continue;
    const arr = feedToAssets.get(a.pyth) ?? [];
    arr.push(Number(id));
    feedToAssets.set(a.pyth, arr);
  }
  const qs   = [...feedToAssets.keys()].map(f => `ids[]=${f}`).join("&");
  const json = await (await fetch(`https://hermes.pyth.network/v2/updates/price/latest?${qs}`)).json() as any;
  for (const e of json.parsed ?? []) {
    const price = Number(e.price.price) * Math.pow(10, e.price.expo);
    for (const aid of feedToAssets.get(`0x${e.id}`) ?? []) state.prices.set(aid, price);
  }
  const oracle = await loadOraclePrices(client, MAINNET);
  for (const [id, p] of oracle) if (!state.prices.has(id)) state.prices.set(id, p);

  console.log(`SUI=$${state.prices.get(0)?.toFixed(4)}  ETH=$${state.prices.get(3)?.toFixed(0)}  USDT=$${state.prices.get(2)?.toFixed(4)}`);

  const data = JSON.parse(readFileSync("logs/positions-cache.json", "utf8"));
  for (const e of data.positions) {
    for (const [k, v] of Object.entries(e.si ?? {})) {
      const id = Number(k);
      if (!reserveCache.has(id))
        reserveCache.set(id, { supplyTableId: "", borrowTableId: "", supplyIndex: BigInt(v as string), borrowIndex: RAY, lastUpdateSec: 0, borrowRatePerSec: 0n, supplyRatePerSec: 0n });
      else reserveCache.get(id)!.supplyIndex = BigInt(v as string);
    }
    for (const [k, v] of Object.entries(e.bi ?? {})) {
      const id = Number(k);
      if (!reserveCache.has(id))
        reserveCache.set(id, { supplyTableId: "", borrowTableId: "", supplyIndex: RAY, borrowIndex: BigInt(v as string), lastUpdateSec: 0, borrowRatePerSec: 0n, supplyRatePerSec: 0n });
      else reserveCache.get(id)!.borrowIndex = BigInt(v as string);
    }
    state.positions.set(e.a, {
      address:           e.a,
      scaledCollaterals: new Map(Object.entries(e.sc).map(([k, v]) => [Number(k), BigInt(v as string)])),
      scaledDebts:       new Map(Object.entries(e.sd).map(([k, v]) => [Number(k), BigInt(v as string)])),
      hf: Infinity, lastUpdated: e.ts ?? Date.now(),
    });
  }

  const opps: any[] = [];
  for (const pos of state.positions.values()) {
    pos.hf = state.computeHF(pos);
    if (!isFinite(pos.hf) || pos.hf >= 1.0) continue;
    const opp = state.bestLiquidation(pos, 0);
    if (!opp) continue;
    opps.push({
      addr: pos.address, hf: pos.hf, source: opp.source,
      debtSym:   state.configs.get(opp.debtAsset)?.symbol   ?? `a${opp.debtAsset}`,
      collatSym: state.configs.get(opp.collatAsset)?.symbol ?? `a${opp.collatAsset}`,
      debtAsset: opp.debtAsset, repayAmount: opp.repayAmount,
      grossProfitUsd: opp.grossProfitUsd, cetusFeeUsd: opp.cetusFeeUsd,
      gasCostUsd: opp.gasCostUsd, profitUsd: opp.profitUsd,
    });
  }
  opps.sort((a, b) => b.profitUsd - a.profitUsd);

  console.log(`\nTotal opps (profit>0):   ${opps.length}`);
  console.log(`Above MIN_PROFIT $0.05:  ${opps.filter(o=>o.profitUsd>=0.05).length}`);
  console.log(`  cetus (direct):        ${opps.filter(o=>o.source==="cetus").length}`);
  console.log(`  cetus-multi (via SUI): ${opps.filter(o=>o.source==="cetus-multi").length}`);
  console.log(`  wallet:                ${opps.filter(o=>o.source==="wallet").length}`);

  const print = (list: typeof opps, label: string) => {
    if (!list.length) return;
    console.log(`\n── ${label} ──`);
    list.forEach(o => {
      console.log(
        `${o.addr.slice(0,22)}  HF=${o.hf.toFixed(3)}  [${o.source}]  ${o.debtSym}→${o.collatSym}` +
        `\n  gross=$${o.grossProfitUsd.toFixed(4)}  cetusFee=$${o.cetusFeeUsd.toFixed(4)}  gas=$${o.gasCostUsd.toFixed(6)}  NET=$${o.profitUsd.toFixed(4)}\n`
      );
    });
  };

  print(opps.filter(o=>o.profitUsd>=0.05), `Above $0.05 (${opps.filter(o=>o.profitUsd>=0.05).length})`);
}

main().catch(e => { console.error(e); process.exit(1); });

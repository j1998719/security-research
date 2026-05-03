/**
 * validate_liquidation_executor.ts — Validate liquidation module on a specific address
 *
 * Fetches on-chain position, computes HF with live prices, then runs devInspect
 * to confirm the liquidation TX would succeed before committing capital.
 *
 * Usage:
 *   ADDR=0x... npx tsx validate_liquidation_executor.ts
 *   ADDR=0x... DRY_RUN=0 npx tsx validate_liquidation_executor.ts  # submit if devInspect passes
 */

import { readFileSync } from "fs";
try {
  for (const line of readFileSync(new URL(".env", import.meta.url), "utf8").split("\n")) {
    const [k, v] = line.split("=");
    if (k?.trim() && v?.trim()) process.env[k.trim()] ??= v.trim();
  }
} catch {}

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { MAINNET } from "./network.js";
import {
  BotState, loadAssetConfigs, loadOraclePrices,
  getReserveInfo, getScaledBalance, getUserInfo, liveIndex,
} from "./position-store.js";
import { buildLiquidationTx } from "./liquidation-executor.js";
import { RAY, ASSETS } from "./config.js";

const client  = new SuiClient({ url: MAINNET.SUI_RPC });
const ADDR    = process.env.ADDR ?? "";
const DRY_RUN = process.env.DRY_RUN !== "0"; // default: devInspect only
const NAVI_DEC = 9;

if (!ADDR) { console.error("Usage: ADDR=0x... npx tsx validate_liquidation_executor.ts"); process.exit(1); }

async function main() {
  console.log(`\n=== Liquidation Executor Validation ===`);
  console.log(`Target:  ${ADDR}`);
  console.log(`Mode:    ${DRY_RUN ? "devInspect only" : "LIVE SUBMIT"}\n`);

  // ── Load state ───────────────────────────────────────────────────────────────
  const state = new BotState();
  await loadAssetConfigs(state, client, MAINNET);
  state.loadCetusFees(MAINNET.CETUS_POOLS);

  // ── Live prices (one-to-many Pyth feed map) ──────────────────────────────────
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
  // Fill non-Pyth assets from NAVI oracle
  const oracle = await loadOraclePrices(client, MAINNET);
  for (const [id, p] of oracle) if (!state.prices.has(id)) state.prices.set(id, p);

  // ── Fetch position ───────────────────────────────────────────────────────────
  const info = await getUserInfo(client, MAINNET, ADDR);
  if (!info || info.loans.length === 0) {
    console.log("No active loans found for this address.");
    return;
  }

  const allIds = [...new Set([...info.collaterals, ...info.loans])];
  await Promise.all(allIds.map(id => getReserveInfo(client, MAINNET, id)));

  const scaledCollaterals = new Map<number, bigint>();
  const scaledDebts       = new Map<number, bigint>();
  for (const id of info.collaterals) {
    const ri = await getReserveInfo(client, MAINNET, id);
    const s  = await getScaledBalance(client, ri.supplyTableId, ADDR);
    if (s > 0n) scaledCollaterals.set(id, s);
  }
  for (const id of info.loans) {
    const ri = await getReserveInfo(client, MAINNET, id);
    const s  = await getScaledBalance(client, ri.borrowTableId, ADDR);
    if (s > 0n) scaledDebts.set(id, s);
  }

  const collatSyms = [...scaledCollaterals.keys()].map(id => state.configs.get(id)?.symbol ?? `a${id}`);
  const debtSyms   = [...scaledDebts.keys()].map(id => state.configs.get(id)?.symbol ?? `a${id}`);
  console.log(`Collateral: [${collatSyms}]`);
  console.log(`Debt:       [${debtSyms}]`);

  // Show current actual balances
  for (const [id, scaled] of scaledCollaterals) {
    const sym  = state.configs.get(id)?.symbol ?? `a${id}`;
    const idx  = liveIndex(id, "supply");
    const actual = Number(scaled * idx / RAY) / 10 ** NAVI_DEC;
    const price  = state.prices.get(id) ?? 0;
    console.log(`  collat ${sym}: ${actual.toFixed(4)} @ $${price.toFixed(4)} = $${(actual * price).toFixed(2)}`);
  }
  for (const [id, scaled] of scaledDebts) {
    const sym  = state.configs.get(id)?.symbol ?? `a${id}`;
    const idx  = liveIndex(id, "borrow");
    const actual = Number(scaled * idx / RAY) / 10 ** NAVI_DEC;
    const price  = state.prices.get(id) ?? 0;
    console.log(`  debt   ${sym}: ${actual.toFixed(4)} @ $${price.toFixed(4)} = $${(actual * price).toFixed(2)}`);
  }

  // ── Compute HF ───────────────────────────────────────────────────────────────
  const pos = { address: ADDR, scaledCollaterals, scaledDebts, hf: 0, lastUpdated: Date.now() };
  pos.hf = state.computeHF(pos);

  if (!isFinite(pos.hf) || pos.hf >= 1.0) {
    console.log(`\nHF = ${pos.hf.toFixed(4)} — position is healthy, not liquidatable.`);
    return;
  }
  console.log(`\nHF = ${pos.hf.toFixed(4)} — LIQUIDATABLE ✓`);

  // ── Best liquidation opportunity ─────────────────────────────────────────────
  const opp = state.bestLiquidation(pos);
  if (!opp) {
    console.log("No profitable liquidation opportunity found.");
    return;
  }

  const debtSym   = state.configs.get(opp.debtAsset)?.symbol   ?? `a${opp.debtAsset}`;
  const collatSym = state.configs.get(opp.collatAsset)?.symbol ?? `a${opp.collatAsset}`;

  console.log(`\n=== Best Opportunity ===`);
  console.log(`  Source:        ${opp.source}`);
  console.log(`  Debt asset:    ${debtSym} (asset ${opp.debtAsset})`);
  console.log(`  Collat asset:  ${collatSym} (asset ${opp.collatAsset})`);
  console.log(`  Repay amount:  ${opp.repayAmount} (raw)`);
  console.log(`  liqBonus:      $${opp.grossProfitUsd.toFixed(4)}`);
  console.log(`  cetusFee:      $${opp.cetusFeeUsd.toFixed(4)}`);
  console.log(`  gas:           $${opp.gasCostUsd.toFixed(6)}`);
  console.log(`  Net profit:    $${opp.profitUsd.toFixed(4)}`);

  if (opp.source === "wallet") {
    console.log(`\n[wallet mode] Requires ${debtSym} in bot wallet to repay.`);
  }

  // ── Build TX and devInspect ──────────────────────────────────────────────────
  const keypair = Ed25519Keypair.fromSecretKey(Buffer.from(process.env.NAVI_BOT_KEY!, "hex"));
  const sender  = keypair.getPublicKey().toSuiAddress();
  console.log(`\nBot wallet: ${sender}`);

  const tx = await buildLiquidationTx(opp, keypair, MAINNET, client, opp.source);

  console.log("\nRunning devInspect...");
  const inspect = await client.devInspectTransactionBlock({ transactionBlock: tx, sender });

  if (inspect.effects?.status?.status === "success") {
    console.log("✅ devInspect PASSED — TX would succeed on-chain");

    if (!DRY_RUN) {
      console.log("\nSubmitting TX...");
      const bytes = await tx.build({ client });
      const { signature } = await keypair.signTransaction(bytes);
      const result = await client.executeTransactionBlock({
        transactionBlock: bytes, signature, options: { showEffects: true },
      });
      if (result.effects?.status?.status === "success") {
        console.log(`✅ TX SUCCESS  digest=${result.digest}`);
      } else {
        console.log(`❌ TX FAILED: ${JSON.stringify(result.effects?.status)}`);
      }
    }
  } else {
    console.log("❌ devInspect FAILED");
    console.log(`Error: ${inspect.effects?.status?.error}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

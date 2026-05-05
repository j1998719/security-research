import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiPriceServiceConnection, SuiPythClient } from "@pythnetwork/pyth-sui-js";
import { MAINNET, BROADCAST_RPCS } from "./network.js";
import {
  ensureStorageTables, loadAssetConfigs, loadOraclePrices, loadUserPosition, BotState,
} from "./position-store.js";
import { buildLiquidationTx } from "./liquidation-executor.js";
import { ASSETS, BOT_KEY } from "./config.js";
import { tg } from "./telegram.js";

const ADDR = "0x4feaa734369febc6e5f5d59d6723bbef4e87b57aa5bad75977c8afcb2938e265";
const NAVI_UI_GETTER = "0xa1357e2e9c28f90e76b085abb81f7ce3e59b699100687bbc3910c7e9f27bb7c8";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io" });
const pythConn = new SuiPriceServiceConnection("https://hermes.pyth.network");
const pythClient = new SuiPythClient(client, MAINNET.PYTH_STATE_ID, MAINNET.WORMHOLE_STATE_ID);

const state = new BotState();
await loadAssetConfigs(state, client, MAINNET);
state.loadCetusFees(MAINNET.CETUS_POOLS);
const oracle = await loadOraclePrices(client, MAINNET);
for (const [id, p] of oracle) state.prices.set(id, p);
await ensureStorageTables(client, MAINNET);
await loadUserPosition(state, client, MAINNET, ADDR);
const pos = state.positions.get(ADDR);
if (!pos) { console.log("No pos"); process.exit(1); }

const allAssets = [...new Set([...pos.scaledCollaterals.keys(), ...pos.scaledDebts.keys()])];
console.log(`Position assets: ${allAssets.map(id => state.configs.get(id)?.symbol).join(",")}`);

// Check NAVI HF
const tx0 = new Transaction();
tx0.moveCall({
  target: `${NAVI_UI_GETTER}::logic_getter_unchecked::user_health_factor`,
  arguments: [
    tx0.object("0x06"),
    tx0.sharedObjectRef({ objectId: MAINNET.NAVI_STORAGE.id, initialSharedVersion: MAINNET.NAVI_STORAGE.isv, mutable: true }),
    tx0.sharedObjectRef({ objectId: MAINNET.PYTH_ORACLE.id, initialSharedVersion: MAINNET.PYTH_ORACLE.isv, mutable: true }),
    tx0.pure.address(ADDR),
  ],
});
const r0 = await client.devInspectTransactionBlock({ transactionBlock: tx0, sender: ADDR });
const rv0 = r0.results?.at(-1)?.returnValues?.[0];
const naviHF = rv0 ? Number(BigInt("0x" + Buffer.from(rv0[0]).reverse().toString("hex"))) / 1e27 : NaN;
console.log(`NAVI HF: ${naviHF.toFixed(4)}`);
if (naviHF >= 1.0) { console.log("Recovered, abort"); process.exit(0); }

const oppOrig = state.bestLiquidation(pos, -Infinity);
if (!oppOrig) { console.log("No opp"); process.exit(1); }
// Apply 10% haircut on top of bestLiquidation's 0.5% haircut for LST pair
const opp = { ...oppOrig, repayAmount: oppOrig.repayAmount * 90n / 100n };
console.log(`Adjusted repay: ${opp.repayAmount} (0.9x)`);
const debtSym = state.configs.get(opp.debtAsset)?.symbol;
const collatSym = state.configs.get(opp.collatAsset)?.symbol;
const debtCfg = state.configs.get(opp.debtAsset);
const dPx = state.prices.get(opp.debtAsset) ?? 0;
const repayUsd = Number(opp.repayAmount) / 10 ** (debtCfg?.tokenDec ?? 9) * dPx;
console.log(`Opp: [${opp.source}] ${debtSym}→${collatSym}  repay=$${repayUsd.toFixed(4)}  est net=$${opp.profitUsd.toFixed(4)}`);

const keypair = Ed25519Keypair.fromSecretKey(Buffer.from(BOT_KEY, "hex"));

// Bundle-all oracle callback
const oracleCallback = async (tx: Transaction) => {
  const seen = new Set<string>();
  const pythFeeds = new Map<string, number>();
  const naviFeeds: any[] = [];
  for (const id of allAssets) {
    const feed = MAINNET.ORACLE_PRO_FEEDS[id];
    const pf = ASSETS[id]?.pyth;
    if (!feed || seen.has(feed.feedId)) continue;
    seen.add(feed.feedId);
    if (pf) pythFeeds.set(pf, id);
    naviFeeds.push(feed);
  }
  if (pythFeeds.size > 0) {
    const ids = [...pythFeeds.keys()];
    const updates = await pythConn.getPriceFeedsUpdateData(ids);
    await pythClient.updatePriceFeeds(tx, updates, ids);
  }
  for (const feed of naviFeeds) {
    tx.moveCall({
      target: `${MAINNET.ORACLE_PRO_PKG}::oracle_pro::update_single_price_v2`,
      arguments: [
        tx.object("0x6"),
        tx.sharedObjectRef({ objectId: MAINNET.ORACLE_CONFIG.id, initialSharedVersion: MAINNET.ORACLE_CONFIG.isv, mutable: true }),
        tx.sharedObjectRef({ objectId: MAINNET.PYTH_ORACLE.id, initialSharedVersion: MAINNET.PYTH_ORACLE.isv, mutable: true }),
        tx.sharedObjectRef({ objectId: MAINNET.SUPRA_HOLDER.id, initialSharedVersion: MAINNET.SUPRA_HOLDER.isv, mutable: false }),
        tx.object(feed.pioId),
        tx.sharedObjectRef({ objectId: MAINNET.SWITCHBOARD_AGG.id, initialSharedVersion: MAINNET.SWITCHBOARD_AGG.isv, mutable: false }),
        tx.pure.address(feed.feedId),
      ],
    });
  }
};

const tx = await buildLiquidationTx(opp, keypair, MAINNET, client, opp.source, oracleCallback);
tx.setGasBudget(50_000_000n);

const sender = keypair.getPublicKey().toSuiAddress();
const inspect = await client.devInspectTransactionBlock({ transactionBlock: tx, sender });
console.log(`devInspect: ${inspect.effects?.status?.status}`);
if (inspect.effects?.status?.status !== "success") {
  console.log(`  err: ${(inspect.effects?.status?.error ?? "").slice(0, 250)}`);
  process.exit(1);
}

const gu = inspect.effects.gasUsed;
console.log(`  gas: ${(Number(gu.computationCost) + Number(gu.storageCost) - Number(gu.storageRebate)) / 1e9} SUI`);
console.log(`Broadcasting...`);
await tg(`🚀 <b>liq-4feaa Executing</b>\n<code>${ADDR}</code>\nNAVI HF=${naviHF.toFixed(4)}\n[${opp.source}] ${debtSym}→${collatSym}\nrepay=$${repayUsd.toFixed(4)}`);

const bytes = await tx.build({ client });
const { signature } = await keypair.signTransaction(bytes);
const result = await Promise.any(BROADCAST_RPCS.map(url =>
  new SuiClient({ url }).executeTransactionBlock({ transactionBlock: bytes, signature, options: { showEffects: true, showBalanceChanges: true } })
    .then(r => { if (r.effects?.status?.status !== "success") throw new Error(`fail`); return r; })
));

console.log(`✅ ${result.digest}`);
const myGains = (result.balanceChanges ?? []).filter((b: any) => b.owner?.AddressOwner === sender);
let netSui = 0n;
for (const b of myGains) { console.log(`  ${b.amount} ${b.coinType.split("::").pop()}`); if (b.coinType === "0x2::sui::SUI") netSui += BigInt(b.amount); }
const sp = state.prices.get(0) ?? 1;
const usd = Number(netSui) / 1e9 * sp;
console.log(`Net SUI: ${netSui} (~$${usd.toFixed(4)})`);
await tg(`✅ <b>liq-4feaa SUCCESS</b>\n<code>${ADDR}</code>\nNet: ${(Number(netSui)/1e9).toFixed(6)} SUI (~$${usd.toFixed(4)})\n<a href="https://suiscan.xyz/mainnet/tx/${result.digest}">${result.digest.slice(0,20)}…</a>`);

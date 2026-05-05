import { SuiClient } from "@mysten/sui/client";
import { MAINNET } from "./network.js";
import {
  ensureStorageTables, loadAssetConfigs, loadOraclePrices, loadUserPosition,
  liveIndex, BotState,
} from "./position-store.js";
import { RAY, GAS_FLASH_MIST, GAS_WALLET_MIST, GAS_WALLET_SWAP_MIST } from "./config.js";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io" });
const addr = "0x7ec74b70485ac3790b35693b7ecfa76f816830ddfeb82f8772befee8b61d9e93";

const state = new BotState();
await loadAssetConfigs(state, client, MAINNET);
state.loadCetusFees(MAINNET.CETUS_POOLS);
const oracle = await loadOraclePrices(client, MAINNET);
for (const [id, p] of oracle) state.prices.set(id, p);

await ensureStorageTables(client, MAINNET);
await loadUserPosition(state, client, MAINNET, addr);
const pos = state.positions.get(addr)!;

console.log("Collat:");
for (const [id, scaled] of pos.scaledCollaterals) {
  const cfg = state.configs.get(id)!;
  console.log(`  asset[${id}] sym=${cfg.symbol} coinType=${cfg.coinType.slice(0,30)}...`);
}
console.log("Debt:");
for (const [id, scaled] of pos.scaledDebts) {
  const cfg = state.configs.get(id)!;
  console.log(`  asset[${id}] sym=${cfg.symbol} coinType=${cfg.coinType.slice(0,30)}...`);
}

// Check pools
const SUI = state.configs.get(0)!.coinType;
for (const [cId] of pos.scaledCollaterals) {
  for (const [dId] of pos.scaledDebts) {
    if (cId === dId) continue;
    const cType = state.configs.get(cId)!.coinType;
    const dType = state.configs.get(dId)!.coinType;
    const direct = state.cetusFees.get(`${cType},${dType}`) ?? state.cetusFees.get(`${dType},${cType}`);
    const cSui = state.cetusFees.get(`${cType},${SUI}`) ?? state.cetusFees.get(`${SUI},${cType}`);
    const dSui = state.cetusFees.get(`${dType},${SUI}`) ?? state.cetusFees.get(`${SUI},${dType}`);
    console.log(`\n${state.configs.get(dId)?.symbol}→${state.configs.get(cId)?.symbol}:`);
    console.log(`  direct  pool: ${direct ?? "MISSING"}`);
    console.log(`  collat/SUI: ${cSui ?? "MISSING"}`);
    console.log(`  debt/SUI:   ${dSui ?? "MISSING"}`);
  }
}

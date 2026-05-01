/**
 * Interest Protocol DEX MasterChef - Security Analysis
 * Package: 0x5c45d10c26c5fb53bfaff819666da6bc7053d2190dfa29fec311cc666ff1f4b0
 * IPX Package: 0x49d87b9af35c4fef28def2cd65884aa9c49bb4eedbcee647f4dafb5c8f36ba57
 */
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const DEX_PKG = "0x5c45d10c26c5fb53bfaff819666da6bc7053d2190dfa29fec311cc666ff1f4b0";
const IPX_PKG = "0x49d87b9af35c4fef28def2cd65884aa9c49bb4eedbcee647f4dafb5c8f36ba57";
const MASTER_CHEF_STORAGE = "0xbf3574ae177272809a7ee8f16c68db8fb832d4b10cb5febc477f90baba5ab6dd";
const ACCOUNT_STORAGE = "0x23fd9726a20709b6f3a59ba676a1d7bfede607ebeb011f888bb33de4f8f44e32";
const IPX_STORAGE = "0xd3c1e174400409c2613559f0309d82fb2a97a1bbc77d6ea39aa1e11f4f6d67d1";
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

// DEX LP coin type for pool key 0 
const IPX_COIN_TYPE = `${IPX_PKG}::ipx::IPX`;

async function main() {
  console.log("=== Interest Protocol DEX MasterChef Security Analysis ===\n");

  // 1. Check the AccountStorage (per-user accounts)
  console.log("--- AccountStorage state ---");
  try {
    const obj = await client.getObject({
      id: ACCOUNT_STORAGE,
      options: { showContent: true, showType: true }
    });
    const fields = (obj.data?.content as any)?.fields ?? {};
    const accounts = fields.accounts;
    console.log(`AccountStorage ID: ${ACCOUNT_STORAGE}`);
    console.log(`accounts bag size: ${accounts?.fields?.size ?? "unknown"}`);
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 80)); }

  // 2. Check what SUI type the pool accepts
  console.log("\n--- Pool key 0 type check ---");
  try {
    const pool = await client.getObject({
      id: "0x5663da95edc0b8ef8b2b9f76148e7c10f5e0bd92d55d63194aed6287d639eaef",
      options: { showContent: true, showType: true }
    });
    console.log("Pool type:", pool.data?.type?.slice(0, 100));
    const fields = (pool.data?.content as any)?.fields ?? {};
    console.log("accrued_ipx_per_share:", fields.accrued_ipx_per_share);
    console.log("balance_value:", fields.balance_value);
    console.log("last_reward_timestamp:", fields.last_reward_timestamp);
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 80)); }

  // 3. Dry-run get_rewards with IPX coin (staking IPX itself in pool 0)
  console.log("\n--- Dry-run: interface::get_rewards ---");
  console.log("(Testing if get_rewards can be called for a fresh account with rewards_paid=0)");
  try {
    const tx = new Transaction();
    tx.moveCall({
      target: `${DEX_PKG}::interface::get_rewards`,
      typeArguments: [IPX_COIN_TYPE],
      arguments: [
        tx.object(MASTER_CHEF_STORAGE),
        tx.object(ACCOUNT_STORAGE),
        tx.object(IPX_STORAGE),
        tx.object(CLOCK),
      ],
    });
    const result = await client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: DUMMY,
    });
    console.log("Status:", result.effects.status.status);
    if (result.effects.status.error) {
      console.log("Error:", result.effects.status.error?.slice(0, 200));
    } else {
      console.log("✅ get_rewards IS callable by fresh address!");
      // Check what was returned/emitted
      const events = result.events ?? [];
      events.forEach(e => {
        console.log("Event:", e.type?.slice(0, 80));
        console.log("  Data:", JSON.stringify(e.parsedJson)?.slice(0, 200));
      });
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 100)); }

  // 4. Check get_pending_rewards to understand reward calculation
  console.log("\n--- get_pending_rewards (view function) ---");
  try {
    const fn = await client.getNormalizedMoveFunction({
      package: DEX_PKG,
      module: "master_chef",
      function: "get_pending_rewards"
    });
    console.log("isEntry:", fn.isEntry);
    console.log("params:", fn.parameters.length);
    fn.parameters.forEach((p, i) => {
      const s = JSON.stringify(p);
      const names = s.match(/"name":"(\w+)"/g)?.map(n => n.split('"')[3]) ?? [];
      console.log(`  param[${i}]: ${names.join(', ') || s.slice(0, 40)}`);
    });
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 80)); }

  // 5. Check if there's a version constant that get_rewards checks
  console.log("\n--- Version guard analysis ---");
  try {
    const mod = await client.getNormalizedMoveModule({
      package: DEX_PKG,
      module: "master_chef"
    });
    // Look for any version-related constants or functions
    const versionFns = Object.keys(mod.exposedFunctions).filter(f => 
      f.toLowerCase().includes('version') || f.toLowerCase().includes('guard')
    );
    console.log("Version-related functions:", versionFns.length ? versionFns : "NONE FOUND");
    
    // Check the interface module too
    const imod = await client.getNormalizedMoveModule({
      package: DEX_PKG,
      module: "interface"
    });
    const ivFns = Object.keys(imod.exposedFunctions).filter(f =>
      f.toLowerCase().includes('version') || f.toLowerCase().includes('guard')
    );
    console.log("Interface version fns:", ivFns.length ? ivFns : "NONE FOUND");
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 80)); }
}

main().catch(console.error);

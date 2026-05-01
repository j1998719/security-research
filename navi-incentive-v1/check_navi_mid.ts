import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const MID_PKG  = "0x81c44854a3b854cd7d3ce48a7c8a21e8a8d0893e2af3a80e3b524b93ee58060d";
const NAVI_V1  = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";
const LATEST   = "0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb";
const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const STORAGE  = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const CLOCK = "0x6";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

async function main() {
  // Check MID_PKG modules
  console.log("=== MID_PKG modules ===");
  try {
    const mods = await client.getNormalizedMoveModulesByPackage({ package: MID_PKG });
    console.log("Modules:", Object.keys(mods).join(", "));
    const fns = (mods as any).incentive_v3?.exposedFunctions ?? {};
    const entries = Object.entries(fns).filter(([_, f]) => (f as any).isEntry);
    console.log(`incentive_v3 entry fns: ${entries.map(([n]) => n).join(", ")}`);
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // Check if MID still has claim_reward_entry
  console.log("\n=== MID_PKG claim_reward_entry signature ===");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: MID_PKG, module: "incentive_v3", function: "claim_reward_entry" });
    console.log("isEntry:", fn.isEntry);
    console.log("Params:", fn.parameters.length);
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // Check NAVI V1 incentive module for all entry functions
  console.log("\n=== NAVI V1 incentive entry functions ===");
  try {
    const mods = await client.getNormalizedMoveModulesByPackage({ package: NAVI_V1 });
    const fns = (mods as any).incentive?.exposedFunctions ?? {};
    const entries = Object.entries(fns).filter(([_, f]) => (f as any).isEntry);
    console.log(`entry fns: ${entries.map(([n]) => n).join(", ")}`);
    
    // Also check incentive_v2 if it exists
    const fns2 = (mods as any).incentive_v2?.exposedFunctions ?? {};
    const entries2 = Object.entries(fns2).filter(([_, f]) => (f as any).isEntry);
    if (entries2.length > 0) console.log(`incentive_v2 entry fns: ${entries2.map(([n]) => n).join(", ")}`);
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // Try dry-run on MID_PKG claim_reward_entry with DUMMY to see if version guard blocks
  console.log("\n=== MID_PKG dry-run test ===");
  try {
    const { Transaction } = require("@mysten/sui/transactions");
    const { bcs } = require("@mysten/sui/bcs");
    
    function hexToBytes(hex: string): number[] {
      const bytes: number[] = [];
      for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
      return bytes;
    }
    
    const CERT_TYPE = "549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT";
    const CERT_FULL = "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT";
    const RULE_1 = "0xda416fe656205ece152240771fe58b301d0c9a0ae43817b7f0cc0faa2742a60e";
    const REWARD_FUND = "0x7093cf7549d5e5b35bfde2177223d1050f71655c7f676a5e610ee70eb4d93b5c";
    
    const tx = new Transaction();
    tx.setSender(DUMMY);
    
    const coinTypesBcs = bcs.vector(bcs.string()).serialize([CERT_TYPE]).toBytes();
    const ruleIdsBcs = bcs.vector(bcs.fixedArray(32, bcs.u8())).serialize([hexToBytes(RULE_1.slice(2).padStart(64,"0"))]).toBytes();
    
    tx.moveCall({
      target: `${MID_PKG}::incentive_v3::claim_reward_entry`,
      typeArguments: [CERT_FULL],
      arguments: [
        tx.object(CLOCK),
        tx.object(INCENTIVE_V3),
        tx.object(STORAGE),
        tx.object(REWARD_FUND),
        tx.pure(coinTypesBcs),
        tx.pure(ruleIdsBcs),
      ],
    });
    
    const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
    const status = r.effects?.status?.status;
    const error = r.effects?.status?.error ?? "";
    const fn = error.match(/function_name: Some\("([^"]+)"\)/)?.[1];
    const code = error.match(/}, (\d+)\)/)?.[1];
    console.log(`MID_PKG status: ${status}`);
    if (error) console.log(`Error: ${error.slice(0, 150)}`);
    if (fn) console.log(`→ aborted in ${fn}() code=${code}`);
  } catch (e: any) { console.log("Error:", e.message?.slice(0,80)); }
}
main().catch(console.error);

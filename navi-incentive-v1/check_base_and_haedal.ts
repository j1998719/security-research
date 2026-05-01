import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const BASE_PKG = "0x41c0788f4ab64cf36dc882174f467634c033bf68c3c1b5ef9819507825eb510b";
const HAEDAL_PKG = "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d";

async function main() {
  // 1. Check BASE user::stake — does it require ObligationKey?
  console.log("=== BASE user::stake params ===");
  const fn = await client.getNormalizedMoveFunction({ package: BASE_PKG, module: "user", function: "stake" });
  for (let i = 0; i < fn.parameters.length; i++) {
    const p = JSON.stringify(fn.parameters[i]);
    const name = p.match(/"name":"(\w+)"/)?.[1] ?? p.slice(0, 80);
    const isMut = p.includes("MutableReference");
    console.log(`  [${i}] ${isMut?"&mut":"ref/val"} ${name}`);
  }
  
  // 2. Check BASE for IncentivePools/IncentiveAccounts objects (active pools)
  console.log("\n=== BASE recent events ===");
  for (const mod of ["user", "admin", "incentive_pool"]) {
    const evts = await client.queryEvents({
      query: { MoveEventModule: { package: BASE_PKG, module: mod } },
      limit: 3, order: "descending",
    });
    if (evts.data.length > 0) {
      console.log(`${mod} (${evts.data.length} events):`);
      for (const e of evts.data.slice(0, 2)) {
        console.log(`  ${e.type?.split("::").pop()} tx=${e.id.txDigest.slice(0,20)}`);
        const pj = JSON.stringify(e.parsedJson ?? {});
        if (pj.includes("reward") || pj.includes("pool") || pj.includes("index")) {
          console.log(`  ${pj.slice(0, 150)}`);
        }
      }
    }
  }
  
  // 3. Find the NEW BorrowIncentive pkg from the recent tx
  // From earlier: tx J6DoC5i7t9F35DaG9XJouK called 0x74922703...::user::stake
  console.log("\n=== Finding new BorrowIncentive package ===");
  const tx = await client.getTransactionBlock({
    digest: "J6DoC5i7t9F35DaG9XJouKrmK8TdFvJkShS6L4gC3C5",
    options: { showInput: true },
  });
  const calls = (tx.transaction?.data?.transaction as any)?.transactions ?? [];
  for (const c of calls) {
    if (c.MoveCall) console.log(`  ${c.MoveCall.package}::${c.MoveCall.module}::${c.MoveCall.function}`);
  }

  // 4. Check Haedal haSUI package entry functions
  console.log("\n=== Haedal haSUI entry functions ===");
  const haedMods = await client.getNormalizedMoveModulesByPackage({ package: HAEDAL_PKG });
  for (const [modName, modData] of Object.entries(haedMods)) {
    const fns = (modData as any).exposedFunctions ?? {};
    const entries = Object.entries(fns).filter(([_, f]) => (f as any).isEntry);
    if (entries.length > 0) {
      console.log(`  ${modName}: ${entries.map(([n]) => n).join(", ")}`);
    }
  }
  
  // 5. Check Haedal for reward-related structs with index patterns
  console.log("\n=== Haedal reward tracking structs ===");
  for (const [modName, modData] of Object.entries(haedMods)) {
    const structs = (modData as any).structs ?? {};
    for (const [sname, sd] of Object.entries(structs)) {
      const fields = (sd as any).fields ?? [];
      const hasIndex = fields.some((f: any) => ["index", "last_index", "user_index", "reward_index", "accumulated_reward"].includes(f.name));
      if (hasIndex) {
        console.log(`  ${modName}::${sname}:`);
        for (const f of fields) console.log(`    ${f.name}: ${JSON.stringify(f.type).slice(0,50)}`);
      }
    }
  }
}
main().catch(console.error);

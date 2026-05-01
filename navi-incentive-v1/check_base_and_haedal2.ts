import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const BASE_PKG = "0x41c0788f4ab64cf36dc882174f467634c033bf68c3c1b5ef9819507825eb510b";
const HAEDAL_PKG = "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d";

async function main() {
  // Find new BorrowIncentive pkg — look at recent user events from BASE
  console.log("=== BASE recent user events ===");
  const userEvts = await client.queryEvents({
    query: { MoveEventModule: { package: BASE_PKG, module: "user" } },
    limit: 5, order: "descending",
  });
  
  const newPkgAddrs = new Set<string>();
  for (const e of userEvts.data) {
    console.log(`  ${e.type?.split("::").pop()} tx=${e.id.txDigest}`);
    const fullTx = await client.getTransactionBlock({ digest: e.id.txDigest, options: { showInput: true } });
    const calls = (fullTx.transaction?.data?.transaction as any)?.transactions ?? [];
    for (const c of calls) {
      if (c.MoveCall?.package && !c.MoveCall.package.startsWith("0x00000") && c.MoveCall.package !== BASE_PKG) {
        newPkgAddrs.add(c.MoveCall.package);
        console.log(`    pkg: ${c.MoveCall.package}::${c.MoveCall.module}::${c.MoveCall.function}`);
      }
    }
  }

  // Check new BorrowIncentive packages found
  for (const pkg of newPkgAddrs) {
    console.log(`\n=== Checking ${pkg.slice(0,20)}... ===`);
    try {
      const mods = await client.getNormalizedMoveModulesByPackage({ package: pkg });
      const modNames = Object.keys(mods);
      console.log("Modules:", modNames.join(", "));
      let hasVersionGuard = false;
      const rewardEntries: string[] = [];
      for (const [modName, modData] of Object.entries(mods)) {
        const structs = (modData as any).structs ?? {};
        for (const [_, sd] of Object.entries(structs)) {
          if (((sd as any).fields ?? []).some((f: any) => f.name === "version")) hasVersionGuard = true;
        }
        const fns = (modData as any).exposedFunctions ?? {};
        for (const [fnName, fnData] of Object.entries(fns)) {
          const isRew = ["claim", "reward", "stake", "redeem", "update_points"].some(kw => fnName.includes(kw));
          if (isRew && (fnData as any).isEntry) rewardEntries.push(`${modName}::${fnName}`);
        }
      }
      console.log(`version_guard=${hasVersionGuard?"YES":"⚠️NO"} reward_entries=${rewardEntries.join(", ")}`);
    } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }
  }

  // Check Haedal haSUI entry functions
  console.log("\n=== Haedal haSUI entry functions ===");
  const haedMods = await client.getNormalizedMoveModulesByPackage({ package: HAEDAL_PKG });
  for (const [modName, modData] of Object.entries(haedMods)) {
    const fns = (modData as any).exposedFunctions ?? {};
    const entries = Object.entries(fns).filter(([_, f]) => (f as any).isEntry);
    if (entries.length > 0) console.log(`  ${modName}: ${entries.map(([n]) => n).join(", ")}`);
  }
  
  // Check Haedal reward tracking structs
  console.log("\n=== Haedal reward tracking structs (index pattern) ===");
  for (const [modName, modData] of Object.entries(haedMods)) {
    const structs = (modData as any).structs ?? {};
    for (const [sname, sd] of Object.entries(structs)) {
      const fields = (sd as any).fields ?? [];
      const hasIndex = fields.some((f: any) => ["index", "last_index", "user_index", "reward_per_share", "accumulated"].includes(f.name));
      if (hasIndex) {
        console.log(`  ${modName}::${sname}:`);
        for (const f of fields) console.log(`    ${f.name}: ${JSON.stringify(f.type).slice(0,50)}`);
      }
    }
  }
}
main().catch(console.error);

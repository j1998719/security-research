/**
 * White-Hat Audit: Scallop Spool V2 (deprecated)
 * Package: 0xec1ac7f4d01c5bf178ff4e62e523e7df7721453d81d4904a42a0ffc2686c843d
 *
 * Vulnerability: last_index uninitialized (0) for new spool accounts
 * Exploit TX: 6WNDjCX3W852hipq6yrHhpUaSFHSPWfTxuLKaQkgNfVL (2026/04/26)
 *
 * This script checks: are there still residual funds? Is V2 still callable?
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const SPOOL_V2 = "0xec1ac7f4d01c5bf178ff4e62e523e7df7721453d81d4904a42a0ffc2686c843d";
const SPOOL_V1 = "0xe87f1b2d498106a2c61421cec75b7b5c5e348512b0dc263949a0e7a3c256571a";
const SPOOL_V3 = "0x472fc7d4c3534a8ec8c2f5d7a557a43050eab057aaab853e8910968ddc84fc9f";

async function main() {
  console.log("=== Scallop Spool Audit ===\n");

  // 1. Check V2 exposed functions
  for (const [label, pkg] of [["V1", SPOOL_V1], ["V2 (deprecated)", SPOOL_V2], ["V3 (current)", SPOOL_V3]]) {
    try {
      const mod = await client.getNormalizedMoveModulesByPackage({ package: pkg as string });
      const modules = Object.keys(mod);
      console.log(`\n${label} (${(pkg as string).slice(0, 20)}...) — modules: ${modules.join(", ")}`);

      for (const modName of modules) {
        const fns = mod[modName].exposedFunctions;
        const entries = Object.entries(fns).filter(([_, f]) => (f as any).isEntry);
        if (entries.length > 0) {
          console.log(`  ${modName} entry functions (${entries.length}):`);
          for (const [name] of entries) console.log(`    [entry] ${name}`);
        }
      }
    } catch (e: any) {
      console.log(`${label}: error — ${e.message?.slice(0, 60)}`);
    }
  }

  // 2. Find the exploit TX to understand the attack
  console.log("\n=== Exploit TX details ===");
  const EXPLOIT_TX = "6WNDjCX3W852hipq6yrHhpUaSFHSPWfTxuLKaQkgNfVL";
  try {
    const tx = await client.getTransactionBlock({
      digest: EXPLOIT_TX,
      options: { showInput: true, showObjectChanges: true, showEvents: true },
    });
    const calls = (tx.transaction?.data?.transaction as any)?.transactions ?? [];
    console.log(`Exploit TX calls (${calls.length}):`);
    for (const c of calls) {
      if (c.MoveCall) {
        console.log(`  ${c.MoveCall.package.slice(0, 20)}::${c.MoveCall.module}::${c.MoveCall.function}`);
      }
    }

    const events = tx.events ?? [];
    console.log(`\nEvents (${events.length}):`);
    for (const e of events.slice(0, 5)) {
      console.log(`  ${e.type?.split("::").pop()}: ${JSON.stringify(e.parsedJson ?? {}).slice(0, 150)}`);
    }

    const changes = tx.objectChanges ?? [];
    const mutated = changes.filter((c: any) => c.type === "mutated");
    console.log(`\nMutated objects: ${mutated.length}`);
    for (const m of mutated.slice(0, 5)) {
      const t = (m as any).objectType?.slice(-50) ?? "";
      if (t.includes("Spool") || t.includes("spool") || t.includes("reward") || t.includes("Reward")) {
        console.log(`  ⭐ ${(m as any).objectId} → ${t}`);
      }
    }
  } catch (e: any) {
    console.log("Exploit TX error:", e.message?.slice(0, 100));
  }

  // 3. Check if there are still active spool reward objects from V2
  console.log("\n=== Querying V2 spool events (post-exploit activity) ===");
  try {
    const events = await client.queryEvents({
      query: { MoveEventModule: { package: SPOOL_V2, module: "spool_account" } },
      limit: 3,
      order: "descending",
    });
    console.log(`Recent V2 spool_account events: ${events.data.length}`);
    for (const e of events.data) {
      console.log(`  ${e.type?.split("::").pop()} tx=${e.id.txDigest.slice(0, 20)}`);
    }
  } catch (e: any) {
    console.log("Event query:", e.message?.slice(0, 80));
  }

  // Try V3 module names to see current spool structure
  try {
    const mod = await client.getNormalizedMoveModulesByPackage({ package: SPOOL_V3 });
    console.log("\n=== V3 module structures ===");
    for (const [modName, modData] of Object.entries(mod)) {
      const fns = (modData as any).exposedFunctions ?? {};
      const entries = Object.entries(fns).filter(([_, f]) => (f as any).isEntry);
      if (entries.length > 0) {
        console.log(`  ${modName} entries: ${entries.map(([n]) => n).join(", ")}`);
      }
    }
  } catch (e: any) {
    console.log("V3 modules:", e.message?.slice(0, 60));
  }
}
main().catch(console.error);

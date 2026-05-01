/**
 * Deep-dive Typus FRAMEWORK_ORIGIN vault module
 * pkg: 0xb4f25230ba74837d8299e92951306100c4a532e8c48cc3d8828abe9b91c8b274
 */
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const TYPUS_FW = "0xb4f25230ba74837d8299e92951306100c4a532e8c48cc3d8828abe9b91c8b274";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

async function main() {
  console.log("=== Typus FRAMEWORK_ORIGIN Vault Deep Audit ===\n");

  // 1. Get vault module exposed functions
  console.log("--- vault module all functions ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: TYPUS_FW, module: "vault" });
    for (const [name, fn] of Object.entries(mod.exposedFunctions)) {
      const vis = fn.visibility;
      const entry = fn.isEntry ? "entry" : "";
      const params = fn.parameters.map((p, i) => {
        const s = JSON.stringify(p);
        const isMut = s.includes("MutableReference");
        const typeName = s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0, 40);
        return `${isMut ? "&mut " : ""}${typeName}`;
      });
      console.log(`  ${vis} ${entry} ${name}(${params.join(", ")})`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 80)); }

  // 2. Vault struct fields
  console.log("\n--- vault structs ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: TYPUS_FW, module: "vault" });
    for (const [name, st] of Object.entries(mod.structs ?? {})) {
      console.log(`  struct ${name}:`);
      for (const f of (st as any).fields ?? []) {
        console.log(`    ${f.name}: ${JSON.stringify(f.type).slice(0, 80)}`);
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 80)); }

  // 3. balance_pool structs
  console.log("\n--- balance_pool structs ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: TYPUS_FW, module: "balance_pool" });
    for (const [name, st] of Object.entries(mod.structs ?? {})) {
      console.log(`  struct ${name}:`);
      for (const f of (st as any).fields ?? []) {
        console.log(`    ${f.name}: ${JSON.stringify(f.type).slice(0, 80)}`);
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 80)); }

  // 4. Detailed signatures for claim/harvest/redeem
  for (const fn_name of ["claim", "harvest", "redeem", "deposit", "withdraw"]) {
    console.log(`\n--- vault::${fn_name} full signature ---`);
    try {
      const fn = await client.getNormalizedMoveFunction({ package: TYPUS_FW, module: "vault", function: fn_name });
      console.log(`  isEntry: ${fn.isEntry}, visibility: ${fn.visibility}`);
      console.log(`  typeParams: ${fn.typeParameters?.length ?? 0}`);
      for (let i = 0; i < fn.parameters.length; i++) {
        const p = JSON.stringify(fn.parameters[i]);
        const isMut = p.includes("MutableReference");
        console.log(`  param[${i}]: ${isMut ? "&mut " : ""}${p.slice(0, 120)}`);
      }
      console.log(`  return: ${JSON.stringify(fn.return).slice(0, 120)}`);
    } catch (e: any) { console.log(`  Not found: ${e.message?.slice(0, 60)}`); }
  }

  // 5. Find vault objects via events
  console.log("\n--- Vault events (newest) ---");
  try {
    const evts = await client.queryEvents({
      query: { MoveEventModule: { package: TYPUS_FW, module: "vault" } },
      limit: 5,
      order: "descending",
    });
    console.log(`Events: ${evts.data.length}`);
    for (const e of evts.data) {
      console.log(`  ${e.type?.split("::").pop()}: ${JSON.stringify(e.parsedJson ?? {}).slice(0, 100)}`);
      console.log(`    tx: ${e.id?.txDigest?.slice(0, 24)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // 6. Try to find Vault object addresses via events (oldest = creation events)
  console.log("\n--- Vault creation events (oldest) ---");
  try {
    const evts = await client.queryEvents({
      query: { MoveEventModule: { package: TYPUS_FW, module: "vault" } },
      limit: 5,
      order: "ascending",
    });
    for (const e of evts.data) {
      const pj = e.parsedJson as any ?? {};
      const vaultId = pj.vault_id ?? pj.id ?? pj.key ?? "?";
      console.log(`  ${e.type?.split("::").pop()}: vault_id=${String(vaultId).slice(0, 40)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // 7. Check authority module for admin cap
  console.log("\n--- authority module functions ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: TYPUS_FW, module: "authority" });
    for (const [name, fn] of Object.entries(mod.exposedFunctions)) {
      const vis = fn.visibility;
      console.log(`  ${vis} ${name}`);
    }
    for (const [name, st] of Object.entries(mod.structs ?? {})) {
      console.log(`  struct ${name}: abilities=${JSON.stringify((st as any).abilities)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // 8. Dry-run vault::claim with dummy sender and no args
  console.log("\n--- Dry-run: vault::claim (detect required params) ---");
  try {
    // First get type params count
    const fn = await client.getNormalizedMoveFunction({ package: TYPUS_FW, module: "vault", function: "claim" });
    console.log(`claim needs ${fn.parameters.length} params, ${fn.typeParameters?.length} type params`);
    // We'll try calling with pure values to see what object types are needed
    const tx = new Transaction();
    tx.moveCall({
      target: `${TYPUS_FW}::vault::claim`,
      typeArguments: [],
      arguments: [],
    });
    const result = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
    console.log(`Status: ${result.effects.status.status}`);
    if (result.effects.status.error) {
      console.log(`Error: ${result.effects.status.error?.slice(0, 200)}`);
    }
  } catch (e: any) { console.log(`Error: ${e.message?.slice(0, 100)}`); }
}

main().catch(console.error);

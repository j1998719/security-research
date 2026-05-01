/**
 * Deep audit Mole Finance vault module
 */
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const MOLE_PKG = "0x5ffa69ee4ee14d899dcc750df92de12bad4bacf81efa1ae12ee76406804dda7f";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

async function main() {
  console.log("=== Mole Finance Deep Audit ===\n");

  // 1. All vault functions
  console.log("--- vault::all functions ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: MOLE_PKG, module: "vault" });
    for (const [name, fn] of Object.entries(mod.exposedFunctions)) {
      const vis = fn.visibility;
      const entry = fn.isEntry ? "entry" : "";
      const params = fn.parameters.map(p => {
        const s = JSON.stringify(p);
        const isMut = s.includes("MutableReference");
        return (isMut ? "&mut " : "") + (s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0, 30));
      });
      console.log(`  ${vis} ${entry} ${name}(${params.join(", ")})`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // 2. All vault structs
  console.log("\n--- vault structs ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: MOLE_PKG, module: "vault" });
    for (const [name, st] of Object.entries(mod.structs ?? {})) {
      const ab = (st as any).abilities?.abilities ?? [];
      console.log(`  struct ${name} [${ab.join(",")}]:`);
      for (const f of (st as any).fields ?? []) {
        console.log(`    ${f.name}: ${JSON.stringify(f.type).slice(0, 80)}`);
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // 3. Check pending_interest signature in detail
  console.log("\n--- vault::pending_interest signature ---");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: MOLE_PKG, module: "vault", function: "pending_interest" });
    console.log(`  isEntry: ${fn.isEntry}, visibility: ${fn.visibility}`);
    for (let i = 0; i < fn.parameters.length; i++) {
      const p = JSON.stringify(fn.parameters[i]);
      const isMut = p.includes("MutableReference");
      console.log(`  param[${i}]: ${isMut ? "&mut " : ""}${p.slice(0, 120)}`);
    }
    console.log(`  return: ${JSON.stringify(fn.return).slice(0, 80)}`);
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // 4. Check managed_vault_config module
  console.log("\n--- managed_vault_config functions ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: MOLE_PKG, module: "managed_vault_config" });
    for (const [name, fn] of Object.entries(mod.exposedFunctions)) {
      const params = fn.parameters.map(p => {
        const s = JSON.stringify(p);
        return s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0, 25);
      });
      console.log(`  ${fn.visibility}${fn.isEntry?" entry":""} ${name}(${params.join(", ")})`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // 5. Find GlobalStorage object
  console.log("\n--- Find GlobalStorage object ---");
  try {
    const evts = await client.queryEvents({
      query: { MoveEventModule: { package: MOLE_PKG, module: "vault" } },
      limit: 3,
      order: "ascending",
    });
    console.log(`Events: ${evts.data.length}`);
    for (const e of evts.data) {
      const pj = e.parsedJson as any ?? {};
      console.log(`  ${e.type?.split("::").pop()}: ${JSON.stringify(pj).slice(0, 100)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // 6. Check if pending_interest is read-only (no mut refs)
  console.log("\n--- Does pending_interest mutate state? ---");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: MOLE_PKG, module: "vault", function: "pending_interest" });
    const hasMutRef = fn.parameters.some(p => JSON.stringify(p).includes("MutableReference"));
    console.log(`Has MutableReference param: ${hasMutRef}`);
    console.log(`Return type: ${JSON.stringify(fn.return)}`);
    if (!hasMutRef) {
      console.log("✅ pending_interest is PURE READ-ONLY — no state mutation possible");
    } else {
      console.log("⚠️ pending_interest has mutable reference — can mutate state");
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }
}

main().catch(console.error);

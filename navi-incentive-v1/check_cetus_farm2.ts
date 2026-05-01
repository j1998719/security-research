import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const PKG = "0x11ea791d82b5742cc8cab0bf7946035c97d9001d7c3803a93f119753da66f526";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

async function main() {
  console.log("=== Cetus Farm: Version Guard & reward_debt Init ===\n");

  // 1. Does harvest check package_version in GlobalConfig?
  console.log("--- router::harvest full bytecode check (via function sig) ---");
  // We can't read bytecode directly, but we can check if version is a param pattern
  try {
    // Look for any internal functions that check version
    const mod = await client.getNormalizedMoveModule({ package: PKG, module: "config" });
    const versionFns = Object.entries(mod.exposedFunctions).filter(([name]) => 
      name.toLowerCase().includes("version") || name.toLowerCase().includes("check")
    );
    console.log(`config version-related fns: ${versionFns.map(([n]) => n).join(", ") || "none"}`);
    
    // Check if there's a check_package_version function
    for (const [name, fn] of Object.entries(mod.exposedFunctions)) {
      if (name.includes("package") || name.includes("version")) {
        console.log(`  ${name}: visibility=${fn.visibility}, isEntry=${fn.isEntry}`);
        console.log(`    params: ${fn.parameters.map(p => JSON.stringify(p).match(/"name":"(\w+)"/)?.[1]).join(", ")}`);
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 2. Find GlobalConfig object on-chain to check current package_version
  console.log("\n--- GlobalConfig object ---");
  try {
    const evts = await client.queryEvents({
      query: { MoveEventModule: { package: PKG, module: "config" } },
      limit: 3,
      order: "descending",
    });
    console.log(`config events: ${evts.data.length}`);
    // Look for GlobalConfig in events
    const evts2 = await client.queryEvents({
      query: { MoveEventModule: { package: PKG, module: "router" } },
      limit: 3,
      order: "descending",
    });
    if (evts2.data.length > 0) {
      for (const e of evts2.data.slice(0, 2)) {
        const pj = e.parsedJson as any ?? {};
        console.log(`router event: ${e.type?.split("::").pop()}: ${JSON.stringify(pj).slice(0,100)}`);
      }
    }
    
    // Try to find GlobalConfig via object type query
    const resp = await (client as any).transport.request({
      method: "suix_queryObjects",
      params: [{ filter: { StructType: `${PKG}::config::GlobalConfig` } }, null, 3, true],
    });
    const objs = resp.data ?? [];
    console.log(`GlobalConfig objects: ${objs.length}`);
    for (const o of objs.slice(0, 2)) {
      const f = o.data?.content?.fields ?? {};
      console.log(`  package_version=${f.package_version}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 3. Recent pool events to find a Pool + RewarderManager ID
  console.log("\n--- Finding Pool and RewarderManager IDs ---");
  try {
    const evts = await client.queryEvents({
      query: { MoveEventModule: { package: PKG, module: "rewarder" } },
      limit: 5,
      order: "descending",
    });
    console.log(`rewarder events: ${evts.data.length}`);
    for (const e of evts.data.slice(0, 3)) {
      const pj = e.parsedJson as any ?? {};
      console.log(`  ${e.type?.split("::").pop()}: ${JSON.stringify(pj).slice(0,120)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 4. harvest events - what does a typical harvest look like?
  console.log("\n--- Recent harvest events ---");
  try {
    const txs = await client.queryTransactionBlocks({
      filter: { MoveFunction: { package: PKG, module: "router", function: "harvest" } },
      limit: 3,
      order: "descending",
      options: { showEvents: true, showInput: true },
    });
    console.log(`Recent harvest txs: ${txs.data.length}`);
    for (const tx of txs.data.slice(0, 2)) {
      const evts = tx.events ?? [];
      for (const e of evts) {
        if (e.type?.includes("Harvest") || e.type?.includes("Reward")) {
          const pj = e.parsedJson as any ?? {};
          console.log(`  ${e.type?.split("::").pop()}: ${JSON.stringify(pj).slice(0,120)}`);
        }
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 5. Pool struct - check for pool-level reward accumulator
  console.log("\n--- Pool struct: all fields ---");
  try {
    const st = await client.getNormalizedMoveStruct({ package: PKG, module: "pool", struct: "Pool" });
    console.log(`abilities: [${st.abilities.abilities.join(", ")}]`);
    for (const f of st.fields) {
      console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0,80)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 6. Rewarder struct - the pool-level accumulator
  console.log("\n--- Rewarder struct ---");
  try {
    const norm = await client.getNormalizedMoveModule({ package: PKG, module: "rewarder" });
    for (const [name, st] of Object.entries(norm.structs)) {
      console.log(`struct ${name}:`);
      for (const f of st.fields.slice(0, 8)) {
        console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0,60)}`);
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }
}
main().catch(console.error);

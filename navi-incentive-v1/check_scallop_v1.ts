/**
 * Deep check Scallop Spool V1 (0xe87f1b2d...) for reward index vulnerability
 * V2 was exploited via SpoolAccount.index=0 bug; V1 might have same issue
 */
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const V1_PKG = "0xe87f1b2d498106a2c61421cec75b7b5c5e348512b0dc263949a0e7a3c256571a";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

async function main() {
  console.log("=== Scallop Spool V1 Deep Audit ===\n");

  // 1. Check all functions in user module
  console.log("--- user module functions ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: V1_PKG, module: "user" });
    for (const [fnName, fnDef] of Object.entries(mod.exposedFunctions)) {
      const params = fnDef.parameters.map(p => {
        const s = JSON.stringify(p);
        const isMut = s.includes("MutableReference");
        const name = s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0, 30);
        return (isMut ? "&mut " : "") + name;
      });
      const mark = fnDef.isEntry ? "✅ entry" : "   public";
      console.log(`  ${mark} ${fnName}(${params.slice(0, 5).join(", ")})`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // 2. SpoolAccount struct
  console.log("\n--- SpoolAccount struct ---");
  try {
    const st = await client.getNormalizedMoveStruct({ package: V1_PKG, module: "spool_account", struct: "SpoolAccount" });
    for (const f of st.fields) {
      console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0, 60)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // 3. Spool struct  
  console.log("\n--- Spool struct ---");
  try {
    const st = await client.getNormalizedMoveStruct({ package: V1_PKG, module: "spool", struct: "Spool" });
    for (const f of st.fields) {
      console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0, 60)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // 4. Check if there are still active Spool objects from V1
  console.log("\n--- V1 spool activity (oldest events) ---");
  try {
    const evts = await client.queryEvents({
      query: { MoveEventModule: { package: V1_PKG, module: "user" } },
      limit: 5,
      order: "ascending",
    });
    console.log(`User module events (oldest): ${evts.data.length}`);
    for (const e of evts.data.slice(0, 3)) {
      console.log(`  ${e.type?.split("::").pop()}: spool=${(e.parsedJson as any)?.spool_id?.slice(0,20)} tx=${e.id.txDigest.slice(0,20)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // 5. Recent V1 activity
  console.log("\n--- V1 recent TXs ---");
  try {
    const txs = await client.queryTransactionBlocks({
      filter: { MoveFunction: { package: V1_PKG, module: "user" } },
      limit: 3,
      order: "descending",
    });
    console.log(`Recent V1 user txs: ${txs.data.length}`);
    for (const tx of txs.data) {
      console.log(`  ${tx.digest.slice(0, 20)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // 6. Check rewards_pool struct
  console.log("\n--- rewards_pool module structs ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: V1_PKG, module: "rewards_pool" });
    for (const [sName, sDef] of Object.entries(mod.structs)) {
      const fields = sDef.fields?.map((f: any) => f.name) ?? [];
      console.log(`  ${sName}: ${fields.join(", ")}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // 7. Try dry-run: stake via V1 user module (if stake is entry)
  // First check if stake requires SpoolAccount
  console.log("\n--- V1 user::stake signature ---");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: V1_PKG, module: "user", function: "stake" });
    console.log("isEntry:", fn.isEntry);
    for (let i = 0; i < fn.parameters.length; i++) {
      const p = JSON.stringify(fn.parameters[i]);
      const isMut = p.includes("MutableReference");
      const name = p.match(/"name":"(\w+)"/)?.[1] ?? p.slice(0, 50);
      console.log(`  param[${i}] ${isMut?"&mut":""}: ${name}`);
    }
  } catch (e: any) { console.log("stake not found or error:", e.message?.slice(0, 60)); }

  // 8. Find Spool objects still active in V1
  console.log("\n--- V1 Spool events (for finding pool IDs) ---");
  try {
    const evts = await client.queryEvents({
      query: { MoveEventType: `${V1_PKG}::spool::SpoolCreatedEvent` },
      limit: 5,
    });
    console.log(`Spool created events: ${evts.data.length}`);
    for (const e of evts.data) {
      const pj = e.parsedJson as any ?? {};
      const spoolId = pj.spool_id ?? pj.id ?? "?";
      console.log(`  spool_id: ${String(spoolId).slice(0, 40)}`);
      // Check spool object
      if (spoolId !== "?") {
        try {
          const obj = await client.getObject({ id: String(spoolId), options: { showContent: true } });
          const f = (obj.data?.content as any)?.fields ?? {};
          console.log(`    current_index=${f.current_spool_index ?? f.index ?? "?"} stakes=${f.total_stakes ?? "?"}`);
        } catch {}
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }
}
main().catch(console.error);

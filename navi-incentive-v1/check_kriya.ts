/**
 * Deep check Kriya AMM 0xa0eba10b... for reward index vulnerability
 */
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const KRIYA_PKG = "0xa0eba10b173538c8fecca1dff298e488402cc9ff374f8a12ca7758eebe830b66";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";

async function main() {
  console.log("=== Kriya AMM Deep Audit ===\n");

  // 1. Get all structs
  console.log("--- Pool struct fields ---");
  try {
    const st = await client.getNormalizedMoveStruct({ package: KRIYA_PKG, module: "spot_dex", struct: "Pool" });
    for (const f of st.fields) {
      console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0, 80)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // Check ProtocolConfigs
  console.log("\n--- ProtocolConfigs struct fields ---");
  try {
    const st = await client.getNormalizedMoveStruct({ package: KRIYA_PKG, module: "spot_dex", struct: "ProtocolConfigs" });
    for (const f of st.fields) {
      console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0, 80)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // 2. claim_fees signature
  console.log("\n--- claim_fees signature ---");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: KRIYA_PKG, module: "spot_dex", function: "claim_fees" });
    console.log("isEntry:", fn.isEntry);
    console.log("typeParameters:", JSON.stringify(fn.typeParameters));
    for (let i = 0; i < fn.parameters.length; i++) {
      const p = JSON.stringify(fn.parameters[i]);
      const isMut = p.includes("MutableReference");
      console.log(`  param[${i}]: ${isMut ? "&mut " : ""}${p.slice(0, 100)}`);
    }
    console.log("return:", JSON.stringify(fn.return));
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // 3. List ALL entry functions
  console.log("\n--- All entry functions ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: KRIYA_PKG, module: "spot_dex" });
    for (const [name, fn] of Object.entries(mod.exposedFunctions)) {
      if (fn.isEntry) {
        const params = fn.parameters.map(p => {
          const s = JSON.stringify(p);
          return s.match(/"name":"(\w+)"/)?.[1] ?? s.slice(0, 30);
        });
        console.log(`  ✅ ${name}(${params.join(", ")})`);
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // 4. Check if there's a newer Kriya package (this might be an old one)
  console.log("\n--- Recent txs on Kriya pkg ---");
  try {
    const txs = await client.queryTransactionBlocks({
      filter: { MoveFunction: { package: KRIYA_PKG, module: "spot_dex" } },
      limit: 5,
      order: "descending",
    });
    console.log(`Recent txs: ${txs.data.length}`);
    for (const tx of txs.data) {
      console.log(`  ${tx.digest.slice(0, 24)} @ checkpoint ${tx.checkpoint}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // 5. Query events from this package for fee claims
  console.log("\n--- Recent claim_fees events ---");
  try {
    const evts = await client.queryEvents({
      query: { MoveEventModule: { package: KRIYA_PKG, module: "spot_dex" } },
      limit: 5,
      order: "descending",
    });
    console.log(`Events: ${evts.data.length}`);
    for (const e of evts.data.slice(0, 3)) {
      console.log(`  ${e.type?.split("::").pop()}: ${JSON.stringify(e.parsedJson ?? {}).slice(0, 100)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // 6. Try to find Pool objects
  console.log("\n--- Finding Pool objects via events ---");
  try {
    const evts = await client.queryEvents({
      query: { MoveEventType: `${KRIYA_PKG}::spot_dex::PoolCreatedEvent` },
      limit: 3,
      order: "descending",
    });
    if (evts.data.length > 0) {
      for (const e of evts.data) {
        const pj = e.parsedJson as any ?? {};
        const poolId = pj.pool_id ?? pj.id ?? "unknown";
        console.log(`  Pool: ${String(poolId).slice(0, 30)} event_type: ${e.type?.split("::").pop()}`);
        // Check pool object
        if (poolId !== "unknown") {
          const obj = await client.getObject({ id: String(poolId), options: { showContent: true } });
          const fields = (obj.data?.content as any)?.fields ?? {};
          const balA = fields.token_x_reserve ?? fields.reserve_x ?? fields.balance_a ?? "?";
          const balB = fields.token_y_reserve ?? fields.reserve_y ?? fields.balance_b ?? "?";
          const fees = fields.unclaimed_fee_x ?? fields.fee_x ?? "?";
          console.log(`    balance_a=${balA} balance_b=${balB} unclaimed_fees=${fees}`);
        }
      }
    } else {
      // Try generic event query
      const evts2 = await client.queryEvents({
        query: { MoveEventModule: { package: KRIYA_PKG, module: "spot_dex" } },
        limit: 3,
        order: "ascending",
      });
      console.log(`Generic events (oldest 3): ${evts2.data.length}`);
      for (const e of evts2.data) {
        const pj = JSON.stringify(e.parsedJson ?? {});
        console.log(`  ${e.type?.split("::").pop()}: ${pj.slice(0, 120)}`);
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 80)); }
}

main().catch(console.error);

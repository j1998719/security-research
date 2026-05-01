import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const SPOOL_V3 = "0x472fc7d4c3534a8ec8c2f5d7a557a43050eab057aaab853e8910968ddc84fc9f";
const SPOOL_V1 = "0xe87f1b2d498106a2c61421cec75b7b5c5e348512b0dc263949a0e7a3c256571a";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";
const CLOCK = "0x6";

async function main() {
  // 1. Check SpoolAccount struct in V3
  console.log("=== V3 SpoolAccount struct ===");
  try {
    const st = await client.getNormalizedMoveStruct({ package: SPOOL_V3, module: "spool_account", struct: "SpoolAccount" });
    for (const f of st.fields) {
      console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0, 80)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // 2. Check user::stake signature in V3
  console.log("\n=== V3 user::stake ===");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: SPOOL_V3, module: "user", function: "stake" });
    console.log("isEntry:", fn.isEntry);
    for (let i = 0; i < fn.parameters.length; i++) {
      const p = JSON.stringify(fn.parameters[i]);
      const typeStr = p.match(/"name":"(\w+)"/)?.[1] ?? p.slice(0, 60);
      console.log(`  [${i}] ${typeStr}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // 3. Check V3 user::redeem_rewards (the key function)
  console.log("\n=== V3 user::redeem_rewards ===");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: SPOOL_V3, module: "user", function: "redeem_rewards" });
    console.log("isEntry:", fn.isEntry);
    console.log("Params:", fn.parameters.length);
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // 4. Check V3 Spool struct (the shared pool object)
  console.log("\n=== V3 Spool struct ===");
  try {
    const st = await client.getNormalizedMoveStruct({ package: SPOOL_V3, module: "spool", struct: "Spool" });
    for (const f of st.fields) {
      console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0, 80)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // 5. Find current active Spool objects from V3 events
  console.log("\n=== V3 active events (user module) ===");
  const events = await client.queryEvents({
    query: { MoveEventModule: { package: SPOOL_V3, module: "user" } },
    limit: 5,
    order: "descending",
  });
  console.log(`Recent V3 user events: ${events.data.length}`);
  for (const e of events.data.slice(0, 3)) {
    const pj = e.parsedJson as any ?? {};
    console.log(`  ${e.type?.split("::").pop()} tx=${e.id.txDigest.slice(0,20)}`);
    if (pj.spool_account_id || pj.spool_id) {
      console.log(`    spool=${pj.spool_id?.slice(0,20)} account=${pj.spool_account_id?.slice(0,20)}`);
      console.log(`    index=${pj.index} stakes=${pj.stakes}`);
    }
  }

  // 6. Try to find a V3 Spool object and check its state  
  console.log("\n=== Finding V3 Spool objects ===");
  const stakeEvents = await client.queryEvents({
    query: { MoveEventModule: { package: SPOOL_V3, module: "spool" } },
    limit: 5,
    order: "descending",
  });
  console.log(`V3 spool events: ${stakeEvents.data.length}`);
  const spoolIds = new Set<string>();
  for (const e of stakeEvents.data) {
    const pj = e.parsedJson as any ?? {};
    if (pj.spool_id) spoolIds.add(pj.spool_id);
  }

  // Also get spool IDs from user events
  for (const e of events.data) {
    const pj = e.parsedJson as any ?? {};
    if (pj.spool_id) spoolIds.add(pj.spool_id);
  }
  
  console.log(`Unique spools found: ${spoolIds.size}`);
  for (const sid of Array.from(spoolIds).slice(0, 2)) {
    const obj = await client.getObject({ id: sid, options: { showContent: true, showType: true } });
    if (obj.error) { console.log(`  ${sid.slice(0,20)}: error`); continue; }
    const f = (obj.data?.content as any)?.fields ?? {};
    console.log(`  ${sid.slice(0,20)}: current_spool_index=${f.current_spool_index} total_stakes=${f.total_stakes}`);
  }
}
main().catch(console.error);

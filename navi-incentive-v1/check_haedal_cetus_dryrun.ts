import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const HAEDAL = "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d";
const CETUS_FARM = "0x11ea791d82b5742cc8cab0bf7946035c97d9001d7c3803a93f119753da66f526";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";

async function checkHaedalClaim() {
  console.log("=== Haedal interface::claim Deep Check ===\n");
  
  // 1. Full function signature
  try {
    const fn = await client.getNormalizedMoveFunction({ package: HAEDAL, module: "interface", function: "claim" });
    console.log(`isEntry: ${fn.isEntry}, visibility: ${fn.visibility}`);
    console.log("Full parameters:");
    for (let i = 0; i < fn.parameters.length; i++) {
      const p = JSON.stringify(fn.parameters[i]);
      const addr = p.match(/"address":"([^"]+)"/)?.[1];
      const name = p.match(/"name":"(\w+)"/)?.[1];
      const isMut = p.includes("MutableReference");
      console.log(`  [${i}]: ${isMut ? "&mut " : ""}${name ?? "?"} (pkg: ${addr?.slice(0,16)})`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 2. What is Staking struct? Does it have version field that's checked?
  console.log("\n--- Haedal Staking struct ---");
  try {
    const st = await client.getNormalizedMoveStruct({ package: HAEDAL, module: "staking", struct: "Staking" });
    console.log("Fields:");
    for (const f of st.fields) {
      console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0,60)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 3. What is the second param to claim (non-TxContext, non-Staking)?
  // Look for UserPosition or UserState struct
  console.log("\n--- Haedal user structs ---");
  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: HAEDAL });
    for (const [mod, modDef] of Object.entries(norm)) {
      for (const [structName, st] of Object.entries(modDef.structs)) {
        const lower = structName.toLowerCase();
        if (lower.includes("user") || lower.includes("position") || lower.includes("stake")) {
          console.log(`${mod}::${structName} abilities:[${st.abilities.abilities.join(",")}]`);
          for (const f of st.fields.slice(0, 6)) {
            console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0,50)}`);
          }
        }
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 4. Is there a UserPosition that defaults reward to 0?
  // Try to find recent claim transactions
  console.log("\n--- Recent Haedal claim txs ---");
  try {
    const txs = await client.queryTransactionBlocks({
      filter: { MoveFunction: { package: HAEDAL, module: "interface", function: "claim" } },
      limit: 3, order: "descending",
      options: { showEvents: true },
    });
    console.log(`Recent claim txs: ${txs.data.length}`);
    for (const tx of txs.data.slice(0, 2)) {
      const evts = tx.events ?? [];
      for (const e of evts) {
        console.log(`  event: ${e.type?.split("::").pop()}: ${JSON.stringify(e.parsedJson ?? {}).slice(0,100)}`);
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 5. Haedal version check - is it applied in claim?
  console.log("\n--- Haedal all modules ---");
  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: HAEDAL });
    console.log(`Modules: ${Object.keys(norm).join(", ")}`);
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }
}

async function checkCetusFarmRewardDebt() {
  console.log("\n\n=== Cetus Farm reward_debt init: dry-run deposit ===");
  
  // Find a Pool object to use in dry-run
  try {
    const evts = await client.queryEvents({
      query: { MoveEventModule: { package: CETUS_FARM, module: "rewarder" } },
      limit: 5, order: "descending",
    });
    
    let rewarderManagerId = "";
    for (const e of evts.data) {
      const pj = e.parsedJson as any ?? {};
      if (pj.id) { rewarderManagerId = pj.id; break; }
    }
    console.log(`RewarderManager ID: ${rewarderManagerId || "not found in events"}`);
    
    // Get recent deposit to see the pool ID used
    const depositTxs = await client.queryTransactionBlocks({
      filter: { MoveFunction: { package: CETUS_FARM, module: "router", function: "harvest" } },
      limit: 2, order: "descending",
      options: { showInput: true },
    });
    
    if (depositTxs.data.length > 0) {
      const tx = depositTxs.data[0];
      const txData = tx.transaction?.data?.transaction as any;
      const calls = (txData?.transactions ?? []).filter((c: any) => c.MoveCall);
      for (const call of calls) {
        if (call.MoveCall.package === CETUS_FARM) {
          console.log(`harvest call params: ${JSON.stringify(call.MoveCall.arguments).slice(0,200)}`);
        }
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,80)); }

  // Check if collect_clmm_reward (not harvest) is simpler  
  console.log("\n--- collect_clmm_reward: what is it collecting? ---");
  try {
    // This takes TWO GlobalConfig params - likely CLMM GlobalConfig + Farm GlobalConfig
    const fn = await client.getNormalizedMoveFunction({ 
      package: CETUS_FARM, module: "router", function: "collect_clmm_reward" 
    });
    console.log("Parameters:");
    for (let i = 0; i < fn.parameters.length; i++) {
      const p = JSON.stringify(fn.parameters[i]);
      const addr = p.match(/"address":"([^"]+)"/)?.[1];
      const name = p.match(/"name":"(\w+)"/)?.[1];
      const mod = p.match(/"module":"(\w+)"/)?.[1];
      const isMut = p.includes("MutableReference");
      console.log(`  [${i}]: ${isMut ? "&mut " : ""}${name} from pkg ${addr?.slice(0,16)}::${mod}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }
}

async function main() {
  await checkHaedalClaim();
  await checkCetusFarmRewardDebt();
}
main().catch(console.error);

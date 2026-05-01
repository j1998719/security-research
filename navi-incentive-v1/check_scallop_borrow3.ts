import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const PKG = "0xc63072e7f5f4983a2efaf5bdba1480d5e7d74d57948e1c7cc436f8e22cbeb410";
// The IncentivePools type is from a different package
const INCENTIVE_POOLS_PKG = "0x41c0788f4ab64c62da3cbab6fcec03a2e36e66b96fcf22b26a3bb7e578ce0f9c";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";

async function main() {
  console.log("=== Scallop BorrowIncentive Exploit Path Analysis ===\n");

  // 1. Check IncentivePools package structure
  console.log("--- IncentivePools package (0x41c0788f...) ---");
  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: INCENTIVE_POOLS_PKG });
    console.log(`Modules: ${Object.keys(norm).join(", ")}`);
  } catch (e: any) { console.log("Error:", e.message?.slice(0,80)); }

  // 2. Find IncentivePools object on-chain (use events to get the ID)
  console.log("\n--- Finding IncentivePools object via events ---");
  let incentivePoolsId = "";
  let incentiveAccountsId = "";
  
  try {
    const txs = await client.queryTransactionBlocks({
      filter: { MoveFunction: { package: PKG, module: "user", function: "stake" } },
      limit: 3, order: "descending",
      options: { showInput: true, showObjectChanges: true },
    });
    if (txs.data.length > 0) {
      const tx = txs.data[0];
      // Look at object inputs to find IncentivePools and IncentiveAccounts
      const txData = tx.transaction?.data?.transaction as any;
      const inputs = txData?.inputs ?? [];
      console.log(`stake tx inputs: ${inputs.length}`);
      for (const inp of inputs) {
        if (inp.objectType?.includes("IncentivePools")) {
          incentivePoolsId = inp.objectId;
          console.log(`IncentivePools: ${incentivePoolsId}`);
        }
        if (inp.objectType?.includes("IncentiveAccounts")) {
          incentiveAccountsId = inp.objectId;
          console.log(`IncentiveAccounts: ${incentiveAccountsId}`);
        }
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,80)); }

  // 3. Check update_points - what does it actually do?
  console.log("\n--- update_points function details ---");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: PKG, module: "user", function: "update_points" });
    console.log(`isEntry: ${fn.isEntry}, visibility: ${fn.visibility}`);
    console.log("Parameters:");
    for (let i = 0; i < fn.parameters.length; i++) {
      const p = JSON.stringify(fn.parameters[i]);
      const name = p.match(/"name":"(\w+)"/)?.[1] ?? p.slice(0,40);
      const addr = p.match(/"address":"([^"]+)"/)?.[1];
      const isMut = p.includes("MutableReference");
      console.log(`  [${i}]: ${isMut ? "&mut " : ""}${name} (${addr?.slice(0,16)})`);
    }
    // NO ObligationKey required!
    console.log("\n⚠️  update_points does NOT require ObligationKey");
    console.log("   This means anyone with access to an Obligation can update its points");
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 4. Check if Obligation is shared (accessible by anyone)
  console.log("\n--- Obligation struct accessibility ---");
  try {
    // Get Obligation type from the Scallop lending package
    const scallop_lending = "0x41c0788f4ab64c62da3cbab6fcec03a2e36e66b96fcf22b26a3bb7e578ce0f9c";
    const norm = await client.getNormalizedMoveModulesByPackage({ package: scallop_lending });
    console.log(`Scallop lending modules: ${Object.keys(norm).slice(0,8).join(", ")}...`);
    
    // Find Obligation struct
    for (const [mod, modDef] of Object.entries(norm)) {
      if (modDef.structs["Obligation"]) {
        const st = modDef.structs["Obligation"];
        console.log(`Obligation abilities: [${st.abilities.abilities.join(",")}]`);
        // Key = shared object
        if (st.abilities.abilities.includes("Key")) {
          console.log("→ Obligation has Key ability = can be a shared object");
        }
        break;
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 5. Can we dry-run update_points with a dummy obligation?
  console.log("\n--- Dry-run: update_points ---");
  if (incentivePoolsId && incentiveAccountsId) {
    try {
      // Find a real Obligation to reference
      const txs = await client.queryTransactionBlocks({
        filter: { MoveFunction: { package: PKG, module: "user", function: "update_points" } },
        limit: 1, order: "descending",
        options: { showInput: true },
      });
      if (txs.data.length > 0) {
        const txData = txs.data[0].transaction?.data?.transaction as any;
        const inputs = txData?.inputs ?? [];
        let obligationId = "";
        for (const inp of inputs) {
          if (inp.objectType?.includes("Obligation")) {
            obligationId = inp.objectId;
            console.log(`Found Obligation: ${obligationId}`);
            break;
          }
        }
        
        if (obligationId) {
          const tx = new Transaction();
          tx.moveCall({
            target: `${PKG}::user::update_points`,
            arguments: [
              tx.object(incentivePoolsId),
              tx.object(incentiveAccountsId),
              tx.object(obligationId),
              tx.object(CLOCK),
            ],
          });
          const result = await client.devInspectTransactionBlock({
            transactionBlock: tx, sender: DUMMY,
          });
          console.log(`Status: ${result.effects.status.status}`);
          if (result.effects.status.error) {
            console.log(`Error: ${result.effects.status.error?.slice(0,200)}`);
          } else {
            console.log("✅ update_points callable!");
            const mutated = (result.effects.mutatedObjects ?? []).map((m: any) => m.objectId.slice(0,20));
            console.log(`mutatedObjects: ${mutated.join(", ")}`);
          }
        }
      }
    } catch (e: any) { console.log("Dry-run error:", e.message?.slice(0,80)); }
  } else {
    console.log("Could not find IncentivePools/IncentiveAccounts IDs for dry-run");
    // Try to find via events
    try {
      const evts = await client.queryEvents({
        query: { MoveEventModule: { package: PKG, module: "user" } },
        limit: 3, order: "descending",
      });
      console.log(`user events: ${evts.data.length}`);
      for (const e of evts.data.slice(0, 2)) {
        const pj = e.parsedJson as any ?? {};
        console.log(`  ${e.type?.split("::").pop()}: ${JSON.stringify(pj).slice(0,120)}`);
      }
    } catch {}
  }

  // 6. Is there a redeem without ObligationKey?
  console.log("\n--- All PUBLIC/entry functions (without ObligationKey) ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: PKG, module: "user" });
    for (const [fnName, fn] of Object.entries(mod.exposedFunctions)) {
      const params = fn.parameters.map(p => {
        const s = JSON.stringify(p);
        return s.match(/"name":"(\w+)"/)?.[1] ?? "?";
      });
      const hasObligKey = params.some(p => p.includes("ObligationKey"));
      if (!hasObligKey && (fn.isEntry || fn.visibility === "Public")) {
        console.log(`  ${fn.isEntry ? "entry" : "public"} ${fnName}(${params.join(",")})`);
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }
}
main().catch(console.error);

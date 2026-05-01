import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

// Found in PyState previousTx chain!
const OLD_PKG = "0x0f286ad004ea93ea6ad3a953b5d4f3c7306378b0dcc354c3f4ebb1d506d3b47f";
const CURRENT_PKG = "0x2b71664477755b90f9fb71c9c944d5d0d3832fec969260e3f18efc7d855f57c4";
const PY_STATE = "0xc6840365f500bee8732a3a256344a11343936b864c144b7e9de5bb8c54224fbe";
const SY_STATE = "0xccd3898005a269c1e9074fe28bca2ff46784e8ee7c13b576862d9758266c3a4d";
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";
const SSUI_TYPE = "0x53a8c1ffcdac36d993ce3c454d001eca57224541d1953d827ef96ac6d7f8142e::sSUI::SSUI";
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

async function main() {
  console.log("=== Investigate Old Nemo Package ===\n");
  console.log(`Old PKG: ${OLD_PKG}`);

  // 1. Get all modules
  console.log("\n--- Modules ---");
  try {
    const norm = await client.getNormalizedMoveModulesByPackage({ package: OLD_PKG });
    const mods = Object.keys(norm);
    console.log(`Modules (${mods.length}): ${mods.join(", ")}`);
  } catch (e: any) { console.log("Error:", e.message?.slice(0,80)); }

  // 2. Check py module for the vulnerable function
  console.log("\n--- py module: get_sy_amount_in_for_exact_py_out ---");
  try {
    const fn = await client.getNormalizedMoveFunction({
      package: OLD_PKG, module: "py", function: "get_sy_amount_in_for_exact_py_out"
    });
    console.log(`isEntry: ${fn.isEntry}`);
    console.log("parameters:");
    for (let i = 0; i < fn.parameters.length; i++) {
      console.log(`  [${i}]: ${JSON.stringify(fn.parameters[i]).slice(0,80)}`);
    }
    console.log("return:", JSON.stringify(fn.return));
    // Check if PyState is mutable reference
    const pyStateParam = fn.parameters.find(p => JSON.stringify(p).includes("MutableReference"));
    if (pyStateParam) console.log("⚠️  HAS MUTABLE REFERENCE PARAM!");
  } catch (e: any) { console.log("Error:", e.message?.slice(0,80)); }

  // 3. Check sy::borrow
  console.log("\n--- sy::borrow ---");
  try {
    const fn = await client.getNormalizedMoveFunction({
      package: OLD_PKG, module: "sy", function: "borrow"
    });
    console.log(`isEntry: ${fn.isEntry}`);
    console.log("return:", JSON.stringify(fn.return).slice(0,100));
    console.log("isPublic:", fn.visibility === "Public");
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 4. Try dry-run with old package
  console.log("\n--- Dry-run: OLD sy::borrow ---");
  try {
    const tx = new Transaction();
    const [coin, flashLoan] = tx.moveCall({
      target: `${OLD_PKG}::sy::borrow`,
      typeArguments: [SSUI_TYPE],
      arguments: [tx.pure.u64(1_000_000_000), tx.object(SY_STATE)],
    });
    tx.moveCall({
      target: `${OLD_PKG}::sy::repay`,
      typeArguments: [SSUI_TYPE],
      arguments: [flashLoan, coin, tx.object(SY_STATE)],
    });
    const result = await client.devInspectTransactionBlock({
      transactionBlock: tx, sender: DUMMY,
    });
    console.log(`Status: ${result.effects.status.status}`);
    if (result.effects.status.error) {
      console.log(`Error: ${result.effects.status.error?.slice(0,200)}`);
    } else {
      console.log("✅ OLD sy::borrow IS callable!");
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,100)); }

  // 5. Dry-run: OLD get_sy_amount_in_for_exact_py_out — does IT mutate?
  console.log("\n--- Dry-run: OLD get_sy_amount_in_for_exact_py_out ---");
  try {
    const tx = new Transaction();
    tx.moveCall({
      target: `${OLD_PKG}::py::get_sy_amount_in_for_exact_py_out`,
      typeArguments: [SSUI_TYPE],
      arguments: [
        tx.pure.u64(1_000_000_000),
        tx.pure.u128(BigInt("18446744073709551616")),
        tx.object(PY_STATE),
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
      console.log("Return values:", JSON.stringify(result.results?.[0]?.returnValues));
      const mutated = result.effects.mutatedObjects ?? [];
      console.log(`mutatedObjects: ${mutated.length}`);
      if (mutated.some((m: any) => m.objectId === PY_STATE)) {
        console.log("🚨 PyState MUTATED by OLD package! Potential exploit path!");
      } else {
        console.log("PyState NOT mutated (patched at logic level in old pkg too)");
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,100)); }

  // 6. Version guard check
  console.log("\n--- Version guard in old package? ---");
  try {
    const mod = await client.getNormalizedMoveModule({ package: OLD_PKG, module: "market" });
    const hasVersion = Object.values(mod.structs).some(s => 
      s.fields?.some(f => f.name === "version")
    );
    const versionFns = Object.keys(mod.exposedFunctions).filter(f => f.includes("version"));
    console.log(`Struct with version field: ${hasVersion}`);
    console.log(`Version-related fns: ${versionFns.join(", ") || "none"}`);
  } catch (e: any) { console.log("Error:", e.message?.slice(0,80)); }

  // 7. Relationship between old and new package
  console.log("\n--- Is old pkg a predecessor? Check linkage ---");
  try {
    const resp = await (client as any).transport.request({
      method: "sui_getObject",
      params: [OLD_PKG, { showBcs: true }],
    });
    const lt = resp.data?.bcs?.linkageTable ?? {};
    const entries = Object.entries(lt);
    console.log(`linkageTable entries: ${entries.length}`);
    for (const [k, v] of entries.slice(0, 8)) {
      const vid = (v as any).upgraded_id;
      if (vid && !vid.startsWith("0x0000000000000000000000000000000000000000000000000000000000000001")) {
        console.log(`  ${k.slice(0,20)} → ${vid.slice(0,20)}...`);
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,80)); }
}
main().catch(console.error);

import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const NEMO = "0x2b71664477755b90f9fb71c9c944d5d0d3832fec969260e3f18efc7d855f57c4";
// PyState shared object
const PY_STATE_OBJ = "0xc6840365f500bee8732a3a256344a11343936b864c144b7e9de5bb8c54224fbe";

async function main() {
  // 1. PyState struct - what fields does it have?
  console.log("=== py module structs ===");
  try {
    const mod = await client.getNormalizedMoveModule({ package: NEMO, module: "py" });
    for (const [sName, sDef] of Object.entries(mod.structs)) {
      const abilities = (sDef as any).abilities?.abilities ?? [];
      const fields = sDef.fields?.map((f: any) => f.name) ?? [];
      console.log(`  ${sName} [${abilities.join(",")}] fields: ${fields.join(", ")}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 2. All py module functions - which ones take &mut PyState?
  console.log("\n=== py functions with &mut PyState ===");
  try {
    const mod = await client.getNormalizedMoveModule({ package: NEMO, module: "py" });
    for (const [fnName, fnDef] of Object.entries(mod.exposedFunctions)) {
      const hasMotPyState = fnDef.parameters.some(p => {
        const s = JSON.stringify(p);
        return s.includes("MutableReference") && s.includes("PyState");
      });
      if (hasMotPyState) {
        const params = fnDef.parameters.map((p, i) => {
          const s = JSON.stringify(p);
          const isMut = s.includes("MutableReference");
          const name = s.match(/"name":"(\w+)"/)?.[1] ?? `p${i}`;
          return `${isMut?"[MUT]":""}${name}`;
        });
        const mark = fnDef.isEntry ? "✅entry" : "   pub";
        console.log(`  ${mark} ${fnName}(${params.join(",")}) → ${JSON.stringify(fnDef.return).slice(0,40)}`);
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 3. Check PyState object on-chain
  console.log("\n=== PyState object state ===");
  try {
    const obj = await client.getObject({ id: PY_STATE_OBJ, options: { showContent: true, showType: true } });
    const type = obj.data?.type ?? "";
    const fields = (obj.data?.content as any)?.fields ?? {};
    console.log(`Type: ${type.slice(0,80)}`);
    // Show key fields related to yield accumulation
    const interesting = Object.entries(fields).filter(([k]) => 
      k.includes("index") || k.includes("rate") || k.includes("accrued") || k.includes("last")
    );
    interesting.forEach(([k, v]) => console.log(`  ${k} = ${JSON.stringify(v)?.slice(0,60)}`));
    console.log(`  (total fields: ${Object.keys(fields).length})`);
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }

  // 4. Try dry-run: can we call get_sy_amount_in_for_exact_py_out?
  console.log("\n=== Dry-run: get_sy_amount_in_for_exact_py_out ===");
  try {
    const tx = new Transaction();
    tx.moveCall({
      target: `${NEMO}::py::get_sy_amount_in_for_exact_py_out`,
      arguments: [
        tx.pure.u64(1000000000), // 1 SUI worth
        // FixedPoint64 - need to encode 1.0 as fixed point  
        tx.pure.u128(BigInt("18446744073709551616")), // 1.0 in FixedPoint64 (2^64)
        tx.object(PY_STATE_OBJ),
        tx.object("0x0000000000000000000000000000000000000000000000000000000000000006"), // clock
      ],
    });
    const result = await client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: "0x0000000000000000000000000000000000000000000000000000000000001337",
    });
    console.log(`Status: ${result.effects.status.status}`);
    if (result.effects.status.error) {
      console.log(`Error: ${result.effects.status.error?.slice(0, 150)}`);
    }
    if (result.results && result.results.length > 0) {
      console.log(`Result: ${JSON.stringify(result.results[0]).slice(0,100)}`);
    }
  } catch (e: any) {
    console.log(`Dry-run error: ${e.message?.slice(0, 100)}`);
  }

  // 5. Check if there's an older Nemo package (pre-patch)
  console.log("\n=== Checking for older Nemo packages via upgrade history ===");
  try {
    // Try to get upgrade cap or check object versions
    const objInfo = await client.getObject({ 
      id: PY_STATE_OBJ, 
      options: { showContent: true, showType: true, showOwner: true }
    });
    console.log(`Owner: ${JSON.stringify(objInfo.data?.owner).slice(0,80)}`);
    console.log(`Version: ${objInfo.data?.version}`);
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }
}
main().catch(console.error);

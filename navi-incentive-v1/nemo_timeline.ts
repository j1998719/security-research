import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const NEMO_A = "0x2b71664477755b90f9fb71c9c944d5d0d3832fec969260e3f18efc7d855f57c4"; // "current"
const NEMO_B = "0x0f286ad004ea93ea6ad3a953b5d4f3c7306378b0dcc354c3f4ebb1d506d3b47f"; // "discovered"
const PY_STATE = "0xc6840365f500bee8732a3a256344a11343936b864c144b7e9de5bb8c54224fbe";
const SY_STATE = "0xccd3898005a269c1e9074fe28bca2ff46784e8ee7c13b576862d9758266c3a4d";

async function getPackageDeployCheckpoint(pkg: string): Promise<string> {
  try {
    // Find the transaction that created this package
    const txs = await client.queryTransactionBlocks({
      filter: { InputObject: pkg },
      limit: 1,
      order: "ascending",
    });
    if (txs.data.length > 0) return txs.data[0].checkpoint ?? "unknown";
  } catch {}
  return "error";
}

async function main() {
  console.log("=== Nemo Package Timeline ===\n");

  // 1. Get deployment checkpoint for both packages
  const cpA = await getPackageDeployCheckpoint(NEMO_A);
  const cpB = await getPackageDeployCheckpoint(NEMO_B);
  console.log(`NEMO_A (2b71...) first seen at checkpoint: ${cpA}`);
  console.log(`NEMO_B (0f286...) first seen at checkpoint: ${cpB}`);
  console.log(`→ ${parseInt(cpA) < parseInt(cpB) ? "NEMO_A is OLDER" : "NEMO_B is OLDER"}`);

  // 2. What is the actual type of PyState?
  console.log("\n--- PyState object type ---");
  try {
    const obj = await client.getObject({ id: PY_STATE, options: { showType: true } });
    console.log(`Type: ${obj.data?.type}`);
    // The type address tells us which package defined PyState
    const typeAddr = obj.data?.type?.split("::")[0];
    console.log(`Defined by package: ${typeAddr}`);
    if (typeAddr === NEMO_A) console.log("→ PyState defined by NEMO_A");
    else if (typeAddr === NEMO_B) console.log("→ PyState defined by NEMO_B");
    else console.log("→ Defined by DIFFERENT package:", typeAddr);
  } catch (e: any) { console.log("Error:", e.message?.slice(0,80)); }

  // 3. What is the actual type of SyState?
  console.log("\n--- SyState object type ---");
  try {
    const obj = await client.getObject({ id: SY_STATE, options: { showType: true } });
    console.log(`Type: ${obj.data?.type}`);
  } catch (e: any) { console.log("Error:", e.message?.slice(0,80)); }

  // 4. NEMO_B events — when was it active?
  console.log("\n--- NEMO_B market events ---");
  for (const mod of ["market", "sy", "py"]) {
    try {
      const evts = await client.queryEvents({
        query: { MoveEventModule: { package: NEMO_B, module: mod } },
        limit: 3, order: "descending",
      });
      if (evts.data.length > 0) {
        console.log(`${mod}: ${evts.data.length} events, latest tx=${evts.data[0].id?.txDigest?.slice(0,24)}`);
      }
    } catch {}
  }

  // 5. NEMO_A events
  console.log("\n--- NEMO_A market events ---");
  for (const mod of ["market", "sy", "py"]) {
    try {
      const evts = await client.queryEvents({
        query: { MoveEventModule: { package: NEMO_A, module: mod } },
        limit: 3, order: "descending",
      });
      if (evts.data.length > 0) {
        console.log(`${mod}: ${evts.data.length} events, latest tx=${evts.data[0].id?.txDigest?.slice(0,24)}`);
      }
    } catch {}
  }

  // 6. Are there any state objects from NEMO_B that could contain funds?
  console.log("\n--- NEMO_B object queries ---");
  for (const structName of ["PyState", "SyState", "MarketState"]) {
    try {
      const resp = await (client as any).transport.request({
        method: "suix_queryObjects",
        params: [
          { filter: { StructType: `${NEMO_B}::py::${structName}` } },
          null, 3, false,
        ],
      });
      const objs = resp.data ?? [];
      console.log(`NEMO_B::py::${structName}: ${objs.length} objects`);
    } catch {}
    try {
      const resp = await (client as any).transport.request({
        method: "suix_queryObjects",
        params: [
          { filter: { StructType: `${NEMO_B}::sy::${structName}` } },
          null, 3, false,
        ],
      });
      const objs = resp.data ?? [];
      console.log(`NEMO_B::sy::${structName}: ${objs.length} objects`);
    } catch {}
    try {
      const resp = await (client as any).transport.request({
        method: "suix_queryObjects",
        params: [
          { filter: { StructType: `${NEMO_B}::market::${structName}` } },
          null, 3, false,
        ],
      });
      const objs = resp.data ?? [];
      console.log(`NEMO_B::market::${structName}: ${objs.length} objects`);
    } catch {}
  }

  // 7. NEMO_B sy::borrow return type (does FlashLoan have abilities?)
  console.log("\n--- NEMO_B FlashLoan type abilities ---");
  try {
    const st = await client.getNormalizedMoveStruct({ package: NEMO_B, module: "sy", struct: "FlashLoan" });
    console.log(`abilities: [${st.abilities.abilities.join(", ")}]`);
    if (st.abilities.abilities.length === 0) console.log("✅ Proper hot potato (no abilities)");
  } catch (e: any) { console.log("Error:", e.message?.slice(0,60)); }
}
main().catch(console.error);

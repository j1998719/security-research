import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const NEMO = "0x2b71664477755b90f9fb71c9c944d5d0d3832fec969260e3f18efc7d855f57c4";
const PY_STATE = "0xc6840365f500bee8732a3a256344a11343936b864c144b7e9de5bb8c54224fbe";
const SY_STATE = "0xccd3898005a269c1e9074fe28bca2ff46784e8ee7c13b576862d9758266c3a4d";

async function main() {
  console.log("=== Find Pre-Patch Nemo (v3) ===\n");

  // 1. PyState oldest transactions
  console.log("--- PyState oldest txs ---");
  try {
    const txs = await client.queryTransactionBlocks({
      filter: { ChangedObject: PY_STATE },
      options: { showInput: true },
      limit: 5,
      order: "ascending",
    });
    console.log(`Found ${txs.data.length} txs`);
    for (const tx of txs.data) {
      const txData = tx.transaction?.data?.transaction as any;
      const calls = (txData?.transactions ?? []).filter((c: any) => c.MoveCall);
      for (const call of calls) {
        const pkg = call.MoveCall.package;
        console.log(`  pkg=${pkg.slice(0, 20)}... ${call.MoveCall.module}::${call.MoveCall.function} @ ${tx.digest.slice(0,24)}`);
        if (pkg !== NEMO) console.log(`  *** DIFFERENT PKG: ${pkg} ***`);
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,80)); }

  // 2. SyState oldest txs
  console.log("\n--- SyState oldest txs ---");
  try {
    const txs = await client.queryTransactionBlocks({
      filter: { ChangedObject: SY_STATE },
      options: { showInput: true },
      limit: 5,
      order: "ascending",
    });
    console.log(`Found ${txs.data.length} txs`);
    for (const tx of txs.data) {
      const txData = tx.transaction?.data?.transaction as any;
      const calls = (txData?.transactions ?? []).filter((c: any) => c.MoveCall);
      for (const call of calls) {
        const pkg = call.MoveCall.package;
        console.log(`  pkg=${pkg.slice(0,20)}... ${call.MoveCall.module}::${call.MoveCall.function} @ ${tx.digest.slice(0,24)}`);
        if (pkg !== NEMO) console.log(`  *** DIFFERENT PKG: ${pkg} ***`);
      }
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,80)); }

  // 3. Check Nemo package object for linkage table (upgrade history)
  console.log("\n--- Package linkage table ---");
  try {
    const resp = await (client as any).transport.request({
      method: "sui_getObject",
      params: [NEMO, { showBcs: true }],
    });
    const bcsData = resp.data?.bcs;
    if (bcsData) {
      console.log(`Package BCS moduleMap keys: ${Object.keys(bcsData.moduleMap ?? {}).slice(0, 5).join(", ")}`);
      console.log(`linkageTable entries: ${Object.keys(bcsData.linkageTable ?? {}).length}`);
      const lt = bcsData.linkageTable ?? {};
      for (const [k, v] of Object.entries(lt).slice(0, 5)) {
        console.log(`  ${k.slice(0,20)} → ${JSON.stringify(v).slice(0,60)}`);
      }
    } else {
      console.log("No BCS data");
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,80)); }

  // 4. Nemo market_factory events (oldest) - market creation event has initial package
  console.log("\n--- market_factory events oldest ---");
  try {
    const evts = await client.queryEvents({
      query: { MoveEventModule: { package: NEMO, module: "market_factory" } },
      limit: 3, order: "ascending",
    });
    console.log(`${evts.data.length} events`);
    for (const e of evts.data) {
      console.log(`  ${e.type?.split("::").pop()} tx=${e.id?.txDigest?.slice(0,24)}`);
      console.log(`  data=${JSON.stringify(e.parsedJson ?? {}).slice(0,150)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,80)); }

  // 5. sy module events oldest - should show original deployment interactions
  console.log("\n--- sy module events oldest ---");
  try {
    const evts = await client.queryEvents({
      query: { MoveEventModule: { package: NEMO, module: "sy" } },
      limit: 3, order: "ascending",
    });
    console.log(`${evts.data.length} events`);
    for (const e of evts.data) {
      console.log(`  ${e.type?.split("::").pop()} tx=${e.id?.txDigest?.slice(0,24)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,80)); }

  // 6. Nemo PyState previousTransaction chain
  console.log("\n--- PyState previousTx chain (trace back) ---");
  try {
    let currentId = PY_STATE;
    for (let i = 0; i < 5; i++) {
      const obj = await client.getObject({ id: currentId, options: { showPreviousTransaction: true, showContent: true } });
      const prevTx = obj.data?.previousTransaction;
      const version = obj.data?.version;
      console.log(`  v${version} → prevTx: ${prevTx?.slice(0,24)}`);
      if (!prevTx) break;

      const tx = await client.getTransactionBlock({ digest: prevTx, options: { showInput: true } });
      const txData = tx.transaction?.data?.transaction as any;
      const calls = (txData?.transactions ?? []).filter((c: any) => c.MoveCall);
      for (const call of calls) {
        const pkg = call.MoveCall.package;
        if (pkg !== NEMO) {
          console.log(`  *** DIFFERENT PKG at v${version}: ${pkg} ***`);
          console.log(`  fn: ${call.MoveCall.module}::${call.MoveCall.function}`);
        }
      }
      // The "previous version" object — need to fetch by version
      if (i < 4 && version && parseInt(version) > 1) {
        const prevVersion = (parseInt(version) - 1).toString();
        try {
          const pastObj = await (client as any).transport.request({
            method: "sui_tryGetPastObject",
            params: [currentId, parseInt(prevVersion), { showPreviousTransaction: true }],
          });
          const pastPrevTx = pastObj.details?.previousTransaction;
          if (pastPrevTx && pastPrevTx !== prevTx) {
            console.log(`  Past v${prevVersion} prevTx: ${pastPrevTx.slice(0,24)}`);
            const pastTx = await client.getTransactionBlock({ digest: pastPrevTx, options: { showInput: true } });
            const pastTxData = pastTx.transaction?.data?.transaction as any;
            for (const call of (pastTxData?.transactions ?? []).filter((c: any) => c.MoveCall)) {
              const pkg = call.MoveCall.package;
              if (pkg !== NEMO) {
                console.log(`  *** OLD PKG at v${prevVersion}: ${pkg} ***`);
              }
            }
          }
        } catch {}
      }
      break; // Only trace top level for now
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0,80)); }
}
main().catch(console.error);

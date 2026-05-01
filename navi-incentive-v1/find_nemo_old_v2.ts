/**
 * Find pre-patch Nemo package via event history around Sept 2025
 * The Sep 2025 $2.4M exploit may reference old package address in TXs
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

// Current (patched) package
const NEMO_CURRENT = "0x2b71664c8aeb5943a09901e5ede1afb7e8e16b69e7ab97e9e1e03c32ed3c3b12";
// Known objects
const PY_STATE = "0x592ba9a7d8571acbc5e997ea4b1c1e5f50c19e71ecd2b8eb05b53f66f58a19d5";
const SY_STATE = "0x5c56564eff36f6fc0ded2b065f0adc5b05aa9de9bde564e4a36d88f7b5eb7f45";
const SSUI_TYPE = "0x53a8c1ffcdac36d993ce3c454d001eca57224541d1953d827ef96ac6d7f8142e::sSUI::SSUI";

async function main() {
  console.log("=== Find Pre-Patch Nemo Package ===\n");

  // 1. Get PyState object history to find when it was created and by which package
  console.log("--- PyState transaction history (oldest first) ---");
  try {
    const txs = await client.queryTransactionBlocks({
      filter: { ChangedObject: PY_STATE },
      options: { showInput: true },
      limit: 10,
      order: "ascending",
    });
    console.log(`Found ${txs.data.length} txs that changed PyState`);
    for (const tx of txs.data) {
      const txData = tx.transaction?.data?.transaction as any;
      const calls = txData?.transactions ?? [];
      for (const call of calls) {
        if (call.MoveCall) {
          const pkg = call.MoveCall.package;
          if (pkg !== NEMO_CURRENT) {
            console.log(`  ⚠️  OLD PKG FOUND: ${pkg}`);
            console.log(`  Function: ${call.MoveCall.module}::${call.MoveCall.function}`);
            console.log(`  TX: ${tx.digest} @ checkpoint ${tx.checkpoint}`);
          } else {
            console.log(`  Current pkg: ${call.MoveCall.module}::${call.MoveCall.function} @ ${tx.digest.slice(0, 20)}`);
          }
        }
      }
    }
  } catch (e: any) {
    console.log("Error:", e.message?.slice(0, 80));
  }

  // 2. Query Nemo events with ascending order (oldest first) to find first event
  console.log("\n--- Nemo events: oldest first ---");
  try {
    const evts = await client.queryEvents({
      query: { MoveEventModule: { package: NEMO_CURRENT, module: "market" } },
      limit: 5,
      order: "ascending",
    });
    console.log(`market module oldest events: ${evts.data.length}`);
    for (const e of evts.data) {
      console.log(`  ${e.type?.split("::").pop()} @ ${e.id?.txDigest?.slice(0, 20)}`);
      console.log(`    data: ${JSON.stringify(e.parsedJson ?? {}).slice(0, 100)}`);
    }
  } catch (e: any) {
    console.log("Error:", e.message?.slice(0, 80));
  }

  // 3. Check if SyState object history reveals old package
  console.log("\n--- SyState oldest transactions ---");
  try {
    const txs = await client.queryTransactionBlocks({
      filter: { ChangedObject: SY_STATE },
      options: { showInput: true },
      limit: 5,
      order: "ascending",
    });
    console.log(`Found ${txs.data.length} txs`);
    for (const tx of txs.data.slice(0, 3)) {
      const txData = tx.transaction?.data?.transaction as any;
      const calls = txData?.transactions ?? [];
      for (const call of calls) {
        if (call.MoveCall) {
          const pkg = call.MoveCall.package;
          console.log(`  pkg=${pkg.slice(0, 20)} mod=${call.MoveCall.module}::${call.MoveCall.function}`);
          if (pkg !== NEMO_CURRENT) {
            console.log(`  *** OLD PACKAGE: ${pkg} ***`);
          }
        }
      }
    }
  } catch (e: any) {
    console.log("Error:", e.message?.slice(0, 80));
  }

  // 4. Search for any Nemo-related packages via UpgradeCapability
  // If Nemo upgraded, there would be an UpgradeCap for the original package
  console.log("\n--- Checking for Nemo upgrade history via package object ---");
  try {
    const pkg = await client.getObject({
      id: NEMO_CURRENT,
      options: { showContent: true, showBcs: false, showType: true },
    });
    console.log(`Package type: ${pkg.data?.type}`);
    // The package object fields
    const content = pkg.data?.content as any;
    if (content?.dataType === "package") {
      console.log(`linkageTable keys: ${Object.keys(content.linkageTable ?? {}).slice(0, 5).join(", ")}`);
      console.log(`typeOriginTable keys: ${Object.keys(content.typeOriginTable ?? {}).length} entries`);
    }
    console.log(`Full content type: ${content?.dataType}`);
  } catch (e: any) {
    console.log("Error:", e.message?.slice(0, 80));
  }

  // 5. Look for Nemo exploit transactions around Sep 2025
  // The exploit tx should be using the OLD Nemo package
  // Checkpoint at ~Sep 2025 on Sui: roughly checkpoint 30M-40M range
  // Let's search events for any Nemo modules around that time
  console.log("\n--- Search ALL Nemo events (py module, ascending) ---");
  try {
    const evts = await client.queryEvents({
      query: { MoveEventModule: { package: NEMO_CURRENT, module: "py" } },
      limit: 5,
      order: "ascending",
    });
    console.log(`py module oldest events: ${evts.data.length}`);
    for (const e of evts.data) {
      console.log(`  ${e.type?.split("::").pop()} @ ${e.id?.txDigest?.slice(0, 24)} seq=${e.id?.eventSeq}`);
    }
  } catch {}

  // 6. Try to find Nemo market factory / initial deployment
  console.log("\n--- Checking market_factory module oldest events ---");
  try {
    const evts = await client.queryEvents({
      query: { MoveEventModule: { package: NEMO_CURRENT, module: "market_factory" } },
      limit: 5,
      order: "ascending",
    });
    console.log(`market_factory oldest events: ${evts.data.length}`);
    for (const e of evts.data) {
      console.log(`  ${e.type?.split("::").pop()} @ ${e.id?.txDigest?.slice(0, 24)}`);
      const pj = JSON.stringify(e.parsedJson ?? {}).slice(0, 120);
      console.log(`  data: ${pj}`);
    }
  } catch {}

  // 7. Check PyState object's past versions (version field)
  console.log("\n--- PyState current state (check for past_tx) ---");
  try {
    const obj = await client.getObject({
      id: PY_STATE,
      options: { showContent: true, showPreviousTransaction: true },
    });
    const prev = obj.data?.previousTransaction;
    console.log(`PyState previousTransaction: ${prev}`);
    // Trace back
    if (prev) {
      const tx = await client.getTransactionBlock({
        digest: prev,
        options: { showInput: true },
      });
      const txData = tx.transaction?.data?.transaction as any;
      const calls = txData?.transactions ?? [];
      for (const call of calls) {
        if (call.MoveCall) {
          const pkg = call.MoveCall.package;
          console.log(`  Last modifier: pkg=${pkg.slice(0, 30)} fn=${call.MoveCall.module}::${call.MoveCall.function}`);
          if (pkg !== NEMO_CURRENT) {
            console.log(`  *** OLD PACKAGE FOUND: ${pkg} ***`);
          }
        }
      }
    }
  } catch (e: any) {
    console.log("Error:", e.message?.slice(0, 80));
  }
}

main().catch(console.error);

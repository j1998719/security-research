/**
 * Find Mole Finance package address via vault object history
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

// Mole Finance vault objects from their config
const MOLE_SUI_VAULT  = "0xa9e10672b5963897355bf40785770ff5a9b45869b6dca3dbd0ec76a8dec18fca";
const MOLE_USDC_VAULT = "0x3a05b55b080cc696aa43e020d3ea68ebfc5386666a5d1f8f5c0d4f6d1393224e";

async function main() {
  console.log("=== Find Mole Finance Package ===\n");

  // 1. Get vault object type → tells us the package address
  for (const [label, id] of [["SUI_VAULT", MOLE_SUI_VAULT], ["USDC_VAULT", MOLE_USDC_VAULT]]) {
    console.log(`--- ${label}: ${id.slice(0,22)}... ---`);
    try {
      const obj = await client.getObject({ id, options: { showType: true, showContent: true } });
      const type = obj.data?.type ?? "unknown";
      console.log(`  Type: ${type.slice(0, 120)}`);
      const pkgMatch = type.match(/^(0x[a-f0-9]+)::/);
      if (pkgMatch) console.log(`  *** PACKAGE: ${pkgMatch[1]} ***`);

      // Show some fields
      const fields = (obj.data?.content as any)?.fields ?? {};
      const fieldKeys = Object.keys(fields).slice(0, 10);
      console.log(`  Fields: ${fieldKeys.join(", ")}`);
    } catch (e: any) { console.log(`  Error: ${e.message?.slice(0, 60)}`); }
  }

  // 2. Look at recent transactions that touched SUI vault
  console.log("\n--- Recent txs touching SUI vault ---");
  try {
    const txs = await client.queryTransactionBlocks({
      filter: { ChangedObject: MOLE_SUI_VAULT },
      options: { showInput: true },
      limit: 5,
      order: "descending",
    });
    console.log(`Found ${txs.data.length} txs`);
    const pkgsSeen = new Set<string>();
    for (const tx of txs.data) {
      const txData = tx.transaction?.data?.transaction as any;
      const calls = txData?.transactions ?? [];
      for (const call of calls) {
        if (call.MoveCall) {
          pkgsSeen.add(call.MoveCall.package);
          console.log(`  pkg=${call.MoveCall.package.slice(0,20)} ${call.MoveCall.module}::${call.MoveCall.function}`);
        }
      }
    }
    console.log(`Unique packages: ${[...pkgsSeen].join("\n  ")}`);
  } catch (e: any) { console.log(`Error: ${e.message?.slice(0, 60)}`); }
}

main().catch(console.error);

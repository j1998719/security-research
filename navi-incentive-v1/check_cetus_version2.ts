import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const CETUS_INTEGRATE_OLD = "0x996c4d9480708fb8b92aa7acf819fb0497b5ec8e65ba06601cae2fb6db3312c3";
const GLOBAL_CONFIG = "0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f";
const CLOCK = "0x6";
// Need a real pool and position to test
// Let's just check the package_version value first

async function main() {
  // Check current package_version in GlobalConfig
  const cfg = await client.getObject({ id: GLOBAL_CONFIG, options: { showContent: true } });
  const f = (cfg.data?.content as any)?.fields ?? {};
  console.log("GlobalConfig package_version:", f.package_version);

  // Check recent txs from the old integrate to see if they succeed
  const txs = await client.queryTransactionBlocks({
    filter: { MoveFunction: { package: CETUS_INTEGRATE_OLD, module: "pool_script" } },
    options: { showInput: false, showEffects: true },
    limit: 3,
    order: "descending",
  });

  console.log("\nRecent OLD integrate txs:");
  for (const tx of txs.data) {
    const status = (tx as any).effects?.status?.status ?? "unknown";
    const error = (tx as any).effects?.status?.error ?? "";
    console.log(`  ${tx.digest.slice(0, 26)} status=${status}${error ? " err="+error.slice(0,60) : ""}`);
  }

  // Inspect a recent old-integrate TX to see what functions are called
  if (txs.data.length > 0) {
    const digest = txs.data[0].digest;
    const txDetail = await client.getTransactionBlock({
      digest,
      options: { showInput: true, showEffects: true, showEvents: true },
    });
    const calls = (txDetail.transaction?.data?.transaction as any)?.transactions ?? [];
    console.log(`\nDetailed TX ${digest.slice(0, 20)}:`);
    for (const c of calls) {
      if (c.MoveCall) {
        console.log(`  ${c.MoveCall.package.slice(0,20)}::${c.MoveCall.module}::${c.MoveCall.function}`);
      }
    }
    const status = (txDetail as any).effects?.status?.status ?? "unknown";
    console.log(`  Status: ${status}`);
  }

  // Check clmm pool module for version check pattern
  console.log("\n=== CLMM pool module entry functions ===");
  const clmmOld = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb";
  try {
    const mod = await client.getNormalizedMoveModulesByPackage({ package: clmmOld });
    const poolFns = (mod as any).pool?.exposedFunctions ?? {};
    const entries = Object.entries(poolFns).filter(([_, f]) => (f as any).isEntry);
    console.log(`Pool entry functions: ${entries.map(([n]) => n).join(", ")}`);
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }
}
main().catch(console.error);

import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

// Suilend: the package for MAIN_POOL type
const SUILEND_PKG = "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf";
const MAIN_POOL_OBJ = "0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505efe";

async function main() {
  console.log("=== Suilend package modules ===");
  const modules = await client.getNormalizedMoveModulesByPackage({ package: SUILEND_PKG });
  console.log("Modules:", Object.keys(modules).join(", "));

  // Check LendingMarket struct for version
  console.log("\n=== LendingMarket struct ===");
  try {
    const st = await client.getNormalizedMoveStruct({ package: SUILEND_PKG, module: "lending_market", struct: "LendingMarket" });
    for (const f of st.fields) {
      console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0, 80)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // Check claim_rewards signature
  console.log("\n=== lending_market::claim_rewards signature ===");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: SUILEND_PKG, module: "lending_market", function: "claim_rewards" });
    console.log("isEntry:", fn.isEntry);
    for (let i = 0; i < fn.parameters.length; i++) {
      const p = JSON.stringify(fn.parameters[i]);
      console.log(`  [${i}] ${p.slice(0, 120)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // Check if this is a proxy/upgrade pattern — look at package's publish history
  console.log("\n=== Checking if SUILEND_PKG is original or upgrade ===");
  const pkg = await client.getObject({ id: SUILEND_PKG, options: { showContent: false, showType: false } });
  console.log("Package obj:", JSON.stringify(pkg).slice(0, 200));

  // Check the MAIN_POOL object
  console.log("\n=== MAIN_POOL object ===");
  const pool = await client.getObject({ id: MAIN_POOL_OBJ, options: { showContent: true, showType: true } });
  const t = pool.data?.type ?? pool.error;
  const f = (pool.data?.content as any)?.fields ?? {};
  console.log("Type:", typeof t === "string" ? t?.slice(-60) : JSON.stringify(t));
  const fieldNames = Object.keys(f);
  console.log("Fields:", fieldNames.slice(0, 10).join(", "));
  if (f.version !== undefined) console.log("version:", f.version);

  // Check claim_rewards_and_deposit for entry
  console.log("\n=== claim_rewards_and_deposit signature ===");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: SUILEND_PKG, module: "lending_market", function: "claim_rewards_and_deposit" });
    console.log("isEntry:", fn.isEntry);
    for (let i = 0; i < fn.parameters.length; i++) {
      const p = JSON.stringify(fn.parameters[i]);
      console.log(`  [${i}] ${p.slice(0, 120)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }
}
main().catch(console.error);

/**
 * Check Cetus integrate deprecated package version guard
 * Original: 0x996c4d9480708fb8b92aa7acf819fb0497b5ec8e65ba06601cae2fb6db3312c3
 * Current:  0x2d8c2e0fc6dd25b0214b3fa747e0fd27fd54608142cd2e4f64c1cd350cc4add4
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const CETUS_INTEGRATE_OLD = "0x996c4d9480708fb8b92aa7acf819fb0497b5ec8e65ba06601cae2fb6db3312c3";
const CETUS_INTEGRATE_NEW = "0x2d8c2e0fc6dd25b0214b3fa747e0fd27fd54608142cd2e4f64c1cd350cc4add4";
const CETUS_CLMM_OLD = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb";
const CETUS_CLMM_NEW = "0xc6faf3703b0e8ba9ed06b7851134bbbe7565eb35ff823fd78432baa4cbeaa12e";
const CETUS_CONFIG = "0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f";

async function main() {
  // 1. Check if Cetus global_config has a version field
  console.log("=== Cetus GlobalConfig object ===");
  const cfg = await client.getObject({ id: CETUS_CONFIG, options: { showContent: true, showType: true } });
  const cfgF = (cfg.data?.content as any)?.fields ?? {};
  console.log("Type:", cfg.data?.type?.slice(-60));
  console.log("Fields:", JSON.stringify(cfgF).slice(0, 300));

  // 2. Check the pool_script::collect_reward function signature in OLD integrate
  console.log("\n=== OLD integrate pool_script::collect_reward params ===");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: CETUS_INTEGRATE_OLD, module: "pool_script", function: "collect_reward" });
    console.log("isEntry:", fn.isEntry);
    console.log("Params count:", fn.parameters.length);
    for (let i = 0; i < fn.parameters.length; i++) {
      const p = JSON.stringify(fn.parameters[i]);
      console.log(`  [${i}] ${p.slice(0, 120)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 80)); }

  // 3. Check the same function in NEW integrate
  console.log("\n=== NEW integrate pool_script::collect_reward params ===");
  try {
    const fn = await client.getNormalizedMoveFunction({ package: CETUS_INTEGRATE_NEW, module: "pool_script", function: "collect_reward" });
    console.log("isEntry:", fn.isEntry);
    console.log("Params count:", fn.parameters.length);
    for (let i = 0; i < fn.parameters.length; i++) {
      const p = JSON.stringify(fn.parameters[i]);
      console.log(`  [${i}] ${p.slice(0, 120)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 80)); }

  // 4. Check GlobalConfig struct in CLMM for version field
  console.log("\n=== Cetus CLMM GlobalConfig struct ===");
  try {
    const st = await client.getNormalizedMoveStruct({ package: CETUS_CLMM_OLD, module: "config", struct: "GlobalConfig" });
    for (const f of st.fields) {
      console.log(`  ${f.name}: ${JSON.stringify(f.type).slice(0, 80)}`);
    }
  } catch (e: any) { console.log("Error:", e.message?.slice(0, 60)); }

  // 5. Check recent activity on OLD integrate
  console.log("\n=== Recent txs using OLD integrate ===");
  const txs = await client.queryTransactionBlocks({
    filter: { MoveFunction: { package: CETUS_INTEGRATE_OLD, module: "pool_script" } },
    options: { showInput: false },
    limit: 3,
    order: "descending",
  });
  console.log(`Recent OLD integrate txs: ${txs.data.length}`);
  for (const tx of txs.data) {
    console.log(`  ${tx.digest.slice(0, 24)} ts=${tx.timestampMs}`);
  }
}
main().catch(console.error);

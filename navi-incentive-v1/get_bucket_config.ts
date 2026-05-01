/**
 * Get Bucket Protocol package addresses from on-chain config
 */
import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

// From bucket-protocol-sdk/src/consts/entry.ts
const ENTRY_CONFIG_ID = "0x03e79aa64ac007d200aefdcb445e31e24f460279bab6c73babfb031b7464072e";
const BUCKET_PKG      = "0x1906a868f05cec861532d92aa49059580caf72d900ba2c387d5135b6a9727f52";

async function main() {
  console.log("=== Bucket Protocol On-Chain Config ===\n");

  // 1. Get the config object
  console.log("--- ENTRY_CONFIG_ID object ---");
  try {
    const obj = await client.getObject({
      id: ENTRY_CONFIG_ID,
      options: { showContent: true, showType: true }
    });
    const type = obj.data?.type ?? "";
    console.log(`Type: ${type.slice(0, 120)}`);
    const fields = (obj.data?.content as any)?.fields ?? {};
    console.log("Fields:", JSON.stringify(fields, null, 2).slice(0, 2000));
  } catch (e: any) { console.log(`Error: ${e.message?.slice(0, 80)}`); }

  // 2. Get modules in main BUCKET_PKG
  console.log("\n--- BUCKET_PKG modules ---");
  try {
    const mods = await client.getNormalizedMoveModulesByPackage({ package: BUCKET_PKG });
    console.log(`Modules: ${Object.keys(mods).join(", ")}`);
  } catch (e: any) { console.log(`Error: ${e.message?.slice(0, 60)}`); }
}

main().catch(console.error);

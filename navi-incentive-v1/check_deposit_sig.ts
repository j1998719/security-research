import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const PROTO_PKG = "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0";
const V1_PKG = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca";
const MID_PKG = "0x81c408448d0d57b3e371ea94de1d40bf852784d3e225de1e74acab3e8395c18f";

async function showFn(pkg: string, mod: string, fn: string) {
  try {
    const f = await client.getNormalizedMoveFunction({ package: pkg, module: mod, function: fn });
    console.log(`\n=== ${mod}::${fn} (${pkg.slice(0,16)}...) ===`);
    console.log("isEntry:", f.isEntry, "typeParams:", f.typeParameters?.length);
    for (let i = 0; i < f.parameters.length; i++) {
      const p = JSON.stringify(f.parameters[i]);
      // Extract pkg address from Struct types
      const pkgMatch = p.match(/"address":"(0x[0-9a-f]+)"/g);
      const name = p.match(/"name":"(\w+)"/)?.[1] ?? "?";
      const isMut = p.includes("MutableReference");
      const pkgStr = pkgMatch?.map(m => m.replace('"address":"', '').replace('"', '').slice(0, 16)).join(",") ?? "";
      console.log(`  [${i}] ${isMut ? "&mut " : "&"}${name} (pkg: ${pkgStr})`);
    }
  } catch (e: any) {
    console.log(`  Error: ${e.message?.slice(0,100)}`);
  }
}

async function main() {
  // Compare entry_deposit and claim_reward_entry type expectations
  await showFn(PROTO_PKG, "incentive_v3", "entry_deposit");
  await showFn(PROTO_PKG, "incentive_v3", "claim_reward_entry");

  // Check what INCENTIVE_V2 object type is
  const INCENTIVE_V2 = "0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c";
  const iv2 = await client.getObject({ id: INCENTIVE_V2, options: { showContent: true, showType: true } });
  console.log(`\nINCENTIVE_V2 type: ${iv2.data?.type}`);

  const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
  const iv3 = await client.getObject({ id: INCENTIVE_V3, options: { showContent: true, showType: true } });
  console.log(`INCENTIVE_V3 type: ${iv3.data?.type}`);

  // Look for any objects of type 0xd899cf7d::incentive_v3::Incentive
  // by checking if there's a different Incentive object
  const AAFB = "0xaaf735bf83ff564e1b219a0d644de894ef5bdc4b2250b126b2a46dd002331821";
  const aafb = await client.getObject({ id: AAFB, options: { showContent: true, showType: true } });
  console.log(`\n0xaaf735bf (INCENTIVE) type: ${aafb.data?.type}`);

  // Also check if claim_reward_entry exists in the MID_PKG
  await showFn(MID_PKG, "incentive_v3", "claim_reward_entry");
}
main().catch(console.error);

import { SuiClient } from "@mysten/sui/client";
const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io" });
const addr = "0x411d4502562e00bb13596b88bd099dde0ea7a824105d6dec29572ed7f4b1922a";
const lending = await import("@naviprotocol/lending" as any) as any;

const caps = await lending.getUserEModeCaps?.(addr, { client, env: "prod" });
console.log("EModeCaps:", JSON.stringify(caps, (k, v) => typeof v === "bigint" ? v.toString() : v, 2));

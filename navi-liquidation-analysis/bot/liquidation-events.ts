/**
 * liquidation-events.ts — Query recent NAVI liquidation TXs and show actual gas used
 *
 * Usage: npx tsx liquidation-events.ts
 */

import { readFileSync } from "fs";
try {
  for (const line of readFileSync(new URL(".env", import.meta.url), "utf8").split("\n")) {
    const [k, v] = line.split("=");
    if (k?.trim() && v?.trim()) process.env[k.trim()] ??= v.trim();
  }
} catch {}

import { SuiClient } from "@mysten/sui/client";
import { MAINNET } from "./network.js";

const client = new SuiClient({ url: MAINNET.SUI_RPC });

async function main() {
  console.log("Querying recent NAVI liquidation events...\n");

  // Query TXs that touched the NAVI storage object and called liquidate
  const res = await client.queryTransactionBlocks({
    filter: { InputObject: MAINNET.NAVI_STORAGE.id },
    options: { showEffects: true, showInput: true },
    limit: 50,
    order: "descending",
  });

  const liqTxs = res.data.filter(tx => {
    const cmds = (tx.transaction?.data?.transaction as any)?.transactions ?? [];
    return cmds.some((c: any) =>
      c.MoveCall?.function?.toLowerCase().includes("liquidat")
    );
  });

  console.log(`Found ${liqTxs.length} liquidation TXs in last ${res.data.length} NAVI TXs\n`);

  if (!liqTxs.length) {
    // Fall back: search by MoveFunction
    console.log("Trying MoveFunction filter...");
    const res2 = await client.queryTransactionBlocks({
      filter: {
        MoveFunction: {
          package: MAINNET.NAVI_PKG,
          module: "incentive_v3",
          function: "liquidation_v2",
        },
      },
      options: { showEffects: true },
      limit: 10,
      order: "descending",
    });
    console.log(`Found ${res2.data.length} via MoveFunction filter\n`);
    liqTxs.push(...res2.data);
  }

  // Fetch full details for each TX
  const details = await Promise.all(
    liqTxs.slice(0, 10).map(tx =>
      client.getTransactionBlock({
        digest: tx.digest,
        options: { showEffects: true, showInput: true, showBalanceChanges: true },
      }).catch(() => tx)
    )
  );

  for (const tx of details) {
    const g = tx.effects?.gasUsed;
    if (!g) continue;
    const totalMist = Number(g.computationCost) + Number(g.storageCost) - Number(g.storageRebate);
    const totalSui  = totalMist / 1e9;
    const status    = tx.effects?.status?.status ?? "?";
    const cmds      = (tx.transaction?.data?.transaction as any)?.transactions ?? [];
    const fns       = cmds.filter((c: any) => c.MoveCall).map((c: any) => c.MoveCall.function).join(", ");
    const profits   = (tx.balanceChanges ?? [])
      .filter((b: any) => BigInt(b.amount) > 0n && b.owner?.AddressOwner)
      .map((b: any) => `+${b.amount} ${b.coinType?.split("::").pop()}`)
      .join(", ");
    console.log(
      `digest=${tx.digest.slice(0, 20)}  status=${status}` +
      `\n  fns: ${fns}` +
      `\n  compute=${g.computationCost}  storage=${g.storageCost}  rebate=${g.storageRebate}` +
      `\n  total=${totalMist} mist = ${totalSui.toFixed(6)} SUI` +
      (profits ? `\n  profit: ${profits}` : "") +
      `\n`
    );
  }
}

main().catch(e => { console.error(e); process.exit(1); });

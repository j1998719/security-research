/**
 * liquidation-events.ts — Query recent NAVI liquidation TXs
 *
 * Usage:
 *   npx tsx liquidation-events.ts                      # last 50 liquidation_v2 calls
 *   npx tsx liquidation-events.ts <borrower-address>   # filter by borrower
 */

import { SuiClient } from "@mysten/sui/client";
import { MAINNET } from "./network.js";

const client = new SuiClient({ url: MAINNET.SUI_RPC });

const TARGET = process.argv[2]?.toLowerCase();  // optional borrower filter
const LIMIT  = 50;

async function main() {
  console.log(`Querying last ${LIMIT} NAVI liquidation_v2 calls${TARGET ? ` (borrower=${TARGET.slice(0,20)}…)` : ""}...\n`);

  const res = await client.queryTransactionBlocks({
    filter: {
      MoveFunction: {
        package: MAINNET.NAVI_PKG,
        module:  "incentive_v3",
        function: "liquidation_v2",
      },
    },
    options: { showEffects: true, showInput: true },
    limit: LIMIT,
    order: "descending",
  });

  // Fetch full details (balance changes + events) in parallel
  const details = await Promise.all(
    res.data.map(tx =>
      client.getTransactionBlock({
        digest: tx.digest,
        options: { showEffects: true, showInput: true, showBalanceChanges: true, showEvents: true },
      }).catch(() => tx)
    )
  );

  const now = Date.now();
  let printed = 0;

  for (const tx of details) {
    const ts      = Number(tx.timestampMs ?? 0);
    const agoSec  = Math.round((now - ts) / 1000);
    const agoStr  = agoSec < 120 ? `${agoSec}s ago` : agoSec < 7200 ? `${(agoSec/60).toFixed(1)}min ago` : `${(agoSec/3600).toFixed(1)}h ago`;
    const status  = tx.effects?.status?.status ?? "?";
    const sender  = tx.transaction?.data?.sender ?? "?";

    // Extract borrower from tx inputs (liquidation_v2 takes borrower as pure address)
    const inputs  = (tx.transaction?.data?.transaction as any)?.inputs ?? [];
    const borrowers = inputs
      .filter((i: any) => i.type === "pure" && typeof i.value === "string" && i.value.startsWith("0x") && i.value.length === 66)
      .map((i: any) => i.value as string);

    // If borrower filter set, skip non-matching
    if (TARGET) {
      const match = borrowers.some(b => b.toLowerCase() === TARGET || b.toLowerCase().includes(TARGET.slice(2, 18)));
      if (!match) continue;
    }

    const g = tx.effects?.gasUsed;
    const gasMist = g ? Number(g.computationCost) + Number(g.storageCost) - Number(g.storageRebate) : 0;

    // Net profit per positive balance change per receiver
    const gains = (tx.balanceChanges ?? [])
      .filter((b: any) => BigInt(b.amount) > 0n && b.owner?.AddressOwner)
      .map((b: any) => {
        const sym = b.coinType?.split("::").pop() ?? "?";
        const raw = BigInt(b.amount);
        return `+${raw} ${sym}`;
      });

    // Unique functions (collapse repetitions like 24× update_single_price_v2)
    const cmds = (tx.transaction?.data?.transaction as any)?.transactions ?? [];
    const fnCounts = new Map<string, number>();
    for (const c of cmds) {
      const fn = c.MoveCall?.function;
      if (fn) fnCounts.set(fn, (fnCounts.get(fn) ?? 0) + 1);
    }
    const fnSummary = [...fnCounts.entries()]
      .map(([fn, n]) => n > 1 ? `${fn}×${n}` : fn)
      .join(", ");

    console.log(
      `[${new Date(ts).toISOString()}]  ${agoStr}  status=${status}\n` +
      `  digest:   ${tx.digest}\n` +
      `  sender:   ${sender}\n` +
      (borrowers.length ? `  borrower: ${borrowers.join(", ")}\n` : "") +
      `  gas:      ${gasMist} mist (${(gasMist/1e9).toFixed(6)} SUI)\n` +
      `  fns:      ${fnSummary}\n` +
      (gains.length ? `  gains:    ${gains.join("  ")}\n` : "") +
      ""
    );
    printed++;
  }

  if (!printed) {
    console.log(TARGET
      ? `No liquidation_v2 calls found for borrower ${TARGET} in the last ${LIMIT} txs.`
      : "No results.");
  } else {
    console.log(`\n${printed} tx(s) shown.`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

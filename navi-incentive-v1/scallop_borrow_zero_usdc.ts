import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });
const DUMMY = "0x0000000000000000000000000000000000000000000000000000000000001337";

const SCALLOP_LATEST = "0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805";
const VERSION_OBJ    = "0x07871c4b3c847a0f674510d4978d5cf6f960452795e8ff6f189fd2088a3f6ac7";
const MARKET_OBJ     = "0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061939d9";
const CDR            = "0x200abe9bf19751cc566ae35aa58e2b7e4ff688fc1130f8d8909ea09bc137d668";
const X_ORACLE_OBJ   = "0x93d5bf0936b71eb27255941e532fac33b5a5c7759e377b4923af0a1359ad494f";
const CLOCK          = "0x0000000000000000000000000000000000000000000000000000000000000006";
const SUI_TYPE       = "0x2::sui::SUI";

// Deposit SUI as collateral, try to borrow USDC (different coin = allowed)
// USDC on Sui: 0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN
const USDC_TYPE = "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN";

function parseAbort(error: string) {
  const codeMatch = error.match(/MoveAbort\(.+?, (\d+)\)/);
  const modMatches = [...error.matchAll(/name: Identifier\("([^"]+)"\)/g)].map(m => m[1]);
  const fnMatch = error.match(/function_name: Some\("([^"]+)"\)/);
  const code = codeMatch?.[1] ?? "none";
  return `abort ${code} @ ${modMatches.join("::")}::${fnMatch?.[1] ?? "?"}`;
}

async function di(tx: Transaction, label: string) {
  const r = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: DUMMY });
  const status = r.effects?.status?.status;
  const error = r.effects?.status?.error ?? "";
  console.log(`[${label}] ${status} → ${error ? (error.includes("MoveAbort") ? parseAbort(error) : error.slice(0, 120)) : "ok"}`);
  return { status, error };
}

async function main() {
  console.log("=== Borrow USDC (diff from collateral) - zero check test ===\n");
  
  // deposit SUI, borrow USDC amount=0
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    const [obligation, obligationKey, hotPotato] = tx.moveCall({
      target: `${SCALLOP_LATEST}::open_obligation::open_obligation`,
      typeArguments: [], arguments: [tx.object(VERSION_OBJ)],
    });
    const suiCoin = tx.splitCoins(tx.gas, [1_000_000_000]);
    tx.moveCall({
      target: `${SCALLOP_LATEST}::deposit_collateral::deposit_collateral`,
      typeArguments: [SUI_TYPE],
      arguments: [tx.object(VERSION_OBJ), obligation, tx.object(MARKET_OBJ), suiCoin],
    });
    tx.moveCall({
      target: `${SCALLOP_LATEST}::borrow::borrow_entry`,
      typeArguments: [USDC_TYPE],
      arguments: [
        tx.object(VERSION_OBJ), obligation, obligationKey,
        tx.object(MARKET_OBJ), tx.object(CDR),
        tx.pure.u64(0),
        tx.object(X_ORACLE_OBJ), tx.object(CLOCK),
      ],
    });
    tx.moveCall({
      target: `${SCALLOP_LATEST}::open_obligation::return_obligation`,
      typeArguments: [], arguments: [tx.object(VERSION_OBJ), obligation, hotPotato],
    });
    tx.transferObjects([obligationKey], DUMMY);
    await di(tx, "deposit SUI + borrow_entry USDC amount=0");
  }
  
  // deposit SUI, borrow USDC amount=1
  {
    const tx = new Transaction();
    tx.setSender(DUMMY);
    const [obligation, obligationKey, hotPotato] = tx.moveCall({
      target: `${SCALLOP_LATEST}::open_obligation::open_obligation`,
      typeArguments: [], arguments: [tx.object(VERSION_OBJ)],
    });
    const suiCoin = tx.splitCoins(tx.gas, [1_000_000_000]);
    tx.moveCall({
      target: `${SCALLOP_LATEST}::deposit_collateral::deposit_collateral`,
      typeArguments: [SUI_TYPE],
      arguments: [tx.object(VERSION_OBJ), obligation, tx.object(MARKET_OBJ), suiCoin],
    });
    tx.moveCall({
      target: `${SCALLOP_LATEST}::borrow::borrow_entry`,
      typeArguments: [USDC_TYPE],
      arguments: [
        tx.object(VERSION_OBJ), obligation, obligationKey,
        tx.object(MARKET_OBJ), tx.object(CDR),
        tx.pure.u64(1),
        tx.object(X_ORACLE_OBJ), tx.object(CLOCK),
      ],
    });
    tx.moveCall({
      target: `${SCALLOP_LATEST}::open_obligation::return_obligation`,
      typeArguments: [], arguments: [tx.object(VERSION_OBJ), obligation, hotPotato],
    });
    tx.transferObjects([obligationKey], DUMMY);
    await di(tx, "deposit SUI + borrow_entry USDC amount=1");
  }
}

main().catch(console.error);

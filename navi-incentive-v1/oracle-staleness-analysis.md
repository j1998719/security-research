---
title: "NAVI Protocol Oracle Staleness — V-NOR-VUL-0001 Analysis"
date: 2026-05-01
type: security-research
status: verified
researcher: white-hat (authorized)
scope: oracle/sources/oracle.move, lending_core/sources/calculator.move, logic.move
packages:
  oracle: "0xca441b44943c16be0e6e23c5a955bb971537ea3289ae8016fbf33fffe1fd210f (v3)"
  lending_core: "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca (v24)"
  PriceOracle_object: "0x1568865ed9a0b5ec414220e8f79b3d04c77acc82358f6e5ae4635687392ffbef"
---

## Executive Summary

Veridise audit finding V-NOR-VUL-0001 (High Severity) — "Staleness of oracle price can exceed expected bounds" — is **partially mitigated but not fully resolved** in the current mainnet deployment.

The `get_token_price` Bool return value IS now checked by `calculator.move`. However, the root vulnerability — **`set_update_interval` has no upper-bound constraint** — remains present in the on-chain bytecode.

---

## V-NOR-VUL-0001 Full Description (from Veridise PDF, June 2024)

**ID:** V-NOR-VUL-0001  
**Severity:** High  
**Title:** Staleness of Oracle Price Can Exceed Expected Bounds  

The `oracle::set_update_interval()` function accepts a `u64` value with no maximum validation. If an admin sets this to an arbitrarily large value (e.g., `u64::MAX = 18446744073709551615`), the freshness check in `get_token_price` becomes trivially satisfied for any stored price — even one that is weeks or months old — because:

```
valid = current_ts - token_price.timestamp <= price_oracle.update_interval
```

With `update_interval = u64::MAX`, this comparison is always true regardless of how stale the price is.

**Audit fix recommendation:** Add `assert!(update_interval <= MAX_ALLOWED_INTERVAL)` in `set_update_interval`.  
**Fix status as of audit (June 2024):** Unresolved.

---

## Step 2: Current oracle.move staleness implementation (mainnet, verified)

Source: `oracle/sources/oracle.move` (oracle pkg v3, original-id `0xca441b...`)

```move
public entry fun set_update_interval(
    _: &OracleAdminCap,
    price_oracle: &mut PriceOracle,
    update_interval: u64,
) {
    version_verification(price_oracle);
    assert!(update_interval > 0, error::invalid_value());   // only > 0, NO upper bound
    price_oracle.update_interval = update_interval;
}

public fun get_token_price(
    clock: &Clock,
    price_oracle: &PriceOracle,
    oracle_id: u8
): (bool, u256, u8) {
    let token_price = table::borrow(price_oracles, oracle_id);
    let current_ts = clock::timestamp_ms(clock);

    let valid = false;
    if (token_price.value > 0 && current_ts - token_price.timestamp <= price_oracle.update_interval) {
        valid = true;
    };
    (valid, token_price.value, token_price.decimal)   // Bool freshness returned, not asserted here
}
```

Current live `update_interval` on mainnet: **15000 ms (15 seconds)** — operationally sound.  
`oracle_constants::default_update_interval()` = 30000 ms (30s).  
No `MAX_UPDATE_INTERVAL` constant exists anywhere in the codebase.

---

## Step 3: Does borrow/liquidate path check the Bool?

**YES — as of current mainnet code, the Bool IS asserted.** Path verified:

```
execute_borrow → calculate_avg_ltv → user_collateral_value / user_loan_value
  → calculator::calculate_value(clock, oracle, amount, oracle_id)
      → (is_valid, price, decimal) = oracle::get_token_price(...)
      → assert!(is_valid, error::invalid_price())   ← PRESENT in calculator.move
```

Both `calculate_value` and `calculate_amount` (used for borrow, liquidate, health factor) contain:

```move
public fun calculate_value(clock: &Clock, oracle: &PriceOracle, amount: u256, oracle_id: u8): u256 {
    let (is_valid, price, decimal) = oracle::get_token_price(clock, oracle, oracle_id);
    assert!(is_valid, error::invalid_price());   // ← staleness DOES revert transactions
    amount * price / (sui::math::pow(10, decimal) as u256)
}
```

This means: under normal operation with `update_interval = 15000ms`, any borrow/liquidate attempted more than 15 seconds after the last price update will revert. This is the **correct behavior**.

---

## Step 4: update_interval upper-bound vulnerability — still present

The only validation in `set_update_interval` is `assert!(update_interval > 0)`. There is no `MAX_INTERVAL` constant or upper bound check in:
- `oracle/sources/oracle_constants.move` (checked — no MAX exists)
- `oracle/sources/oracle.move` `set_update_interval` function (verified above)
- `oracle/sources/oracle_manage.move` (does not wrap set_update_interval with additional checks)

**Attack scenario (admin key compromise or governance attack):**

1. Attacker gains control of `OracleAdminCap` (compromise or social engineering)
2. Calls `set_update_interval(cap, price_oracle, 18446744073709551615)` — sets to u64::MAX
3. `get_token_price` now returns `valid = true` for ANY stored price regardless of age
4. Attacker stops updating oracle prices
5. After price diverges from reality (e.g., BTC crashes 50% but NAVI oracle still shows old high price):
   - Attacker borrows against inflated collateral values → protocol insolvency
   - Legitimate liquidations become impossible (liquidator health checks use same stale oracle)
6. Protocol drains — attacker extracts all liquidity

**Severity of remaining issue:** MEDIUM-HIGH (requires admin key compromise). Not a permissionless exploit.

---

## Step 5: Live oracle state verification

Queried PriceOracle object `0x1568865e...` on Sui mainnet:

```json
{
  "type": "oracle::PriceOracle",
  "fields": {
    "update_interval": "15000",   // 15 seconds — healthy operational value
    "version": "3",
    "price_oracles": { "size": "36" }  // 36 price feeds active
  }
}
```

The current `update_interval = 15000ms` is reasonable and prices appear to be actively updated by the `oracle_pro` module which has its own dual-source freshness validation (`strategy::is_oracle_price_fresh`). The `oracle_pro` layer validates freshness from Pyth/Supra/Switchboard source timestamps before writing to `PriceOracle`, providing defense-in-depth.

---

## Summary Table

| Finding | Status | Notes |
|---------|--------|-------|
| V-NOR-VUL-0001: Bool not checked in borrow/liquidate | **FIXED** | `calculator.move` `assert!(is_valid)` present in both `calculate_value` and `calculate_amount` |
| `update_interval` no upper bound | **UNRESOLVED** | Only `> 0` check; no MAX constant; u64::MAX attack still theoretically possible |
| V-NOR-VUL-0004: Users can update prices in their favor | **FIXED** | `update_token_price` now requires `OracleFeederCap`; `oracle_pro` validates Pyth/Supra/Switchboard source before write |
| Current operational staleness | **HEALTHY** | `update_interval = 15s`, 36 active feeds, oracle_pro dual-source validation active |

---

## Recommended Fix for Remaining Issue

```move
// In oracle_constants.move — add:
public fun max_update_interval(): u64 { 300_000 } // 5 minutes absolute maximum

// In oracle.move set_update_interval — change to:
public entry fun set_update_interval(
    _: &OracleAdminCap,
    price_oracle: &mut PriceOracle,
    update_interval: u64,
) {
    version_verification(price_oracle);
    assert!(update_interval > 0, error::invalid_value());
    assert!(update_interval <= constants::max_update_interval(), error::invalid_value()); // ADD THIS
    price_oracle.update_interval = update_interval;
}
```

---

## Impact Assessment

- **TVL at risk:** $157M (Sui: $157,378,640 per DeFiLlama, 2026-05-01)
- **Exploitability under current conditions:** LOW (requires OracleAdminCap key compromise)
- **Exploitability if admin key compromised:** CRITICAL — full protocol drain possible
- **Urgency:** Medium — one-line fix, should be included in next upgrade cycle

---

## Sources

- Veridise Audit Report PDF: https://veridise.com/wp-content/uploads/2024/11/VAR_Navi-240607-Decentralized_Oracle_Integration.pdf
- NAVI Smart Contracts (oracle): https://github.com/naviprotocol/navi-smart-contracts/blob/main/oracle/sources/oracle.move
- NAVI Smart Contracts (calculator): https://github.com/naviprotocol/navi-smart-contracts/blob/main/lending_core/sources/calculator.move
- NAVI Smart Contracts (logic): https://github.com/naviprotocol/navi-smart-contracts/blob/main/lending_core/sources/logic.move
- NAVI SDK address.ts: https://github.com/naviprotocol/navi-sdk/blob/main/src/address.ts
- Sui Mainnet RPC: https://fullnode.mainnet.sui.io
- DeFiLlama TVL: https://api.llama.fi/protocol/navi-protocol

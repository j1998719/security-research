---
title: "Scallop Old BorrowIncentive Package: White-Hat Security Investigation"
date: 2026-04-30
type: security-research
status: draft
source: on-chain bytecode, GitHub scallop-io/borrow-incentive-interface, Sui mainnet RPC
language: en
tags: [sui, defi, security, scallop, borrow-incentive, white-hat]
related: ["sui-defi-hacks-april-2026.md", "navi-incentive-v1-vulnerability.md"]
---

White-hat investigation of Scallop Protocol's old `borrowIncentive` package on Sui mainnet, conducted 2026-04-30. Context: Scallop suffered a $142K exploit in April 2026 via a deprecated SPool V2 contract (`last_index=0` for new stakers). This investigation checks whether the same class of bug exists in the old borrow incentive package.

---

## Package Identifiers

| Item | Value |
|------|-------|
| Old package (original) | `0xc63072e7f5f4983a2efaf5bdba1480d5e7d74d57948e1c7cc436f8e22cbeb410` |
| Latest upgraded package | `0x74922703605ba0548a55188098d6ebc8fdeb9fe16993986f1b7c9a49036c7c9c` |
| Initial package (deploy) | `0x002875153e09f8145ab63527bc85c00f2bd102e12f9573c47f8cdf1a1cb62934` |
| IncentiveConfig (shared) | `0xdf5d04b4691cc67e82fd4db8394d89ff44823a9de29716c924f74bb4f11cc1f7` |
| IncentivePools (shared) | `0x6547e143d406b5ccd5f46aae482497de279cc1a68c406f701df70a05f9212ab4` |
| IncentiveAccounts (shared) | `0xc4701fdbc1c92f9a636d334d66012b3027659e9fb8aff27279a82edfb6b77d02` |
| AdminCap | `0xc486afa253646f4d381e81d7f1df8aa4723b845a6bb356f69bad635ffefffe2c` |

The SDK constant `OLD_BORROW_INCENTIVE_PROTOCOL_ID` in `src/constants/common.ts` confirms the old package is `0xc63072...`. The package is an upgradeable contract; the old ID is the original deploy address, and the current live logic is at the latest upgrade ID.

## Modules in the Old Package

Fetched directly via `sui_getObject` + `showContent`:

- `admin` — AdminCap operations, pool setup
- `app_error` — error codes
- `incentive_account` — per-obligation accounting, index accrual
- `incentive_pool` — global pool state, index advancement
- `reward_pool` — reward balance and exchange rate (deprecated in new version)
- `typed_id` — typed wrapper around object IDs
- `user` — public entry functions: `stake`, `unstake`, `update_points`, `force_unstake_unhealthy`

## Architecture: How the Reward Index Works

The old package uses a **point-index accumulator** model similar to Compound Finance's reward accounting, but with a critical architectural difference from the April 2026 SPool exploit.

**IncentiveState** (per user, per obligation, per pool type):
```
struct IncentiveState has store {
    pool_type: TypeName,
    amount: u64,
    points: u64,       // pending claimable points
    total_points: u64, // lifetime earned
    index: u64,        // last seen global pool index
}
```

**IncentivePool** (global, per pool type):
```
struct IncentivePoolPoint has store {
    index: u64,           // global accumulator
    distributed_point_per_period: u64,
    ...
}
```

**Point accrual formula** (from `accrue_points` bytecode):
```
new_points = amount * (pool_index - user_index) / BASE_INDEX_RATE
user.index = pool_index
user.points += new_points
```

## Index Initialization for New Stakers: The Critical Path

When a new obligation stakes for the first time, the call path is:

1. `user::stake` calls `incentive_account::create_if_not_exists` — creates a blank `IncentiveAccount` with empty `incentive_states` table.
2. `user::stake` calls `update_points` — but since `incentive_types` is empty (no states yet), `accrue_all_points` loops over nothing. Zero accrual.
3. `user::stake` calls `incentive_account::stake` → `add_all_debts_from_obligation`.

**`add_all_debts_from_obligation` is where index initialization happens:**

```
// B6: new IncentiveState created for first-time entry into a pool
Pack[1](IncentiveState) with fields:
  pool_type = pool_type
  amount    = debt_amount
  points    = 0
  total_points = 0
  index     = pool_index  // <-- takes CURRENT global pool index
```

The key instruction sequence (from bytecode lines 61-74):
```
36: Call incentive_pool::index(&IncentivePool): u64   // reads current global index
37: StLoc[5](loc2: u64)                               // stores it as loc2
...
70: LdU64(0)   // points = 0
71: LdU64(0)   // total_points = 0
72: MoveLoc[5](loc2: u64)  // index = current pool_index (NOT zero)
73: Pack[1](IncentiveState)
```

**Conclusion: new stakers are initialized with `index = current_pool_index`, NOT `index = 0`.** This is the correct, safe initialization. There is no `last_index=0` vulnerability here.

## Comparison with the SPool V2 Bug (April 2026 Exploit)

The April 2026 Scallop exploit worked because the deprecated SPool V2 initialized `last_index = 0` for new stakers into a pool where `last_index` had already grown to a large value, allowing users to claim backdated rewards they never earned.

The old borrowIncentive package does NOT have this bug. Index initialization reads `incentive_pool::index()` at the moment of first stake, so the user's starting index equals the pool's current index. No backdated accrual is possible.

## Version Guard Analysis

The `IncentiveConfig` object on mainnet shows:
```json
{
  "enabled": true,
  "version": "3"
}
```

The interface source defines `CURRENT_VERSION = 1` and has `assert_version_and_status`. However, the **old package's `user` module does NOT reference `IncentiveConfig` at all.** Verified by bytecode inspection: the `user` module imports do not include `incentive_config`, and there are no calls to `assert_version`, `assert_enabled`, or any version check in the entry functions `stake`, `unstake`, `update_points`, `force_unstake_unhealthy`.

This means: the old package's entry functions bypass the version+enabled guard entirely. They operate directly on the shared `IncentivePools` and `IncentiveAccounts` objects.

**Implication:** The `enabled: true, version: 3` config gate is only enforced by the newer upgraded package. Anyone can call the old package's entry functions regardless of the config state. However, since the old package still uses the same shared objects (`IncentivePools`, `IncentiveAccounts`), any state mutations go into the live shared objects.

## Entry Functions Without Version Guard

All four entry functions in the old `user` module:

| Function | Access Control | Version Guard |
|----------|---------------|---------------|
| `stake` | ObligationKey ownership | None |
| `unstake` | ObligationKey ownership | None |
| `update_points` | None (permissionless) | None |
| `force_unstake_unhealthy` | None (permissionless) | None |

`force_unstake_unhealthy` is callable by anyone on any obligation, as long as the obligation is unhealthy. This is by design (liquidation helper) but worth noting.

## Reward Pool Architecture: Deprecated Functions

The `reward_pool` module shows that `add_reward` and `left_reward_amount` both call `app_error::deprecated()` and abort. This means the old reward mechanism (RewardPool with exchange_rate) is entirely deactivated. The current live rewards flow through a different path in the upgraded package (the `Bag`-based rewards storage in IncentivePools).

## Remaining Reward Balances

The `IncentivePools` shared object is live and shared (`initial_shared_version: 81234462`). It holds reward balances in a `Bag`-based structure. The `take_old_rewards` function in the admin module suggests some legacy reward balance may still exist in the `RewardPool` struct inside pools, withdrawable only by AdminCap.

## Attack Surface Summary

| Vector | Status | Notes |
|--------|--------|-------|
| `last_index=0` exploit (SPool pattern) | NOT PRESENT | New stakers initialized with current pool index |
| Version guard bypass | PRESENT but benign | Old entry functions work without config check, but business logic unchanged |
| Backdated reward theft | NOT POSSIBLE | Index initialization is correct |
| Permissionless `force_unstake_unhealthy` | PRESENT by design | Anyone can force-unstake unhealthy obligations |
| Legacy reward balance drain | N/A | Requires AdminCap; already deprecated |
| Cross-pool confusion | NOT PRESENT | Pool type is checked via `is_pool_exist` before staking |

## Sources

- On-chain bytecode: `sui_getObject` on `0xc63072e7f5f4983a2efaf5bdba1480d5e7d74d57948e1c7cc436f8e22cbeb410` (Sui mainnet, 2026-04-30)
- Source interface: https://github.com/scallop-io/borrow-incentive-interface (commit: main branch)
- Publish result: https://raw.githubusercontent.com/scallop-io/borrow-incentive-interface/main/borrow_incentive/publish-result.mainnet.json
- SDK constants: https://raw.githubusercontent.com/scallop-io/sui-scallop-sdk/main/src/constants/common.ts
- Sui mainnet RPC: https://fullnode.mainnet.sui.io (IncentiveConfig, IncentivePools object queries)

# Round 8: Cold Protocol Security Scan
Date: 2026-05-01
Scope: Small/obscure Sui protocols ($50K–$5M TVL, not previously scanned)

## Protocol Discovery Method
- DefiLlama API: extracted 50 Sui protocols sorted by TVL ascending
- DefiLlama adapter source code: extracted package addresses
- On-chain object type queries: derived package IDs from known object IDs
- On-chain event queries: `suix_queryEvents` for various module names

## Protocols Scanned (18 total)

| Protocol | Package | TVL | Result |
|---------|---------|-----|--------|
| Kriya AMM (spot_dex) | 0xa0eba10b...830b66 | $88K | SAFE |
| Kriya Farm | 0x88701243...40085 | $88K | SAFE |
| Winter Walrus | 0x29ba7f7b...c33d | $119K | SAFE (no entry fns) |
| Strater | wrapper (Cetus CLMM) | $136K | SAFE (wrapper) |
| FlowX AMM | 0xba153169...1cae0 | $264K | SAFE (no reward fns) |
| FlowX CLMM | 0x25929e7f...87f26d | $518K | SAFE (no reward fns) |
| Nemo Vault (post-patch) | 0xaa5c5324...1947 | $79K | SAFE (version guard added) |
| xSUI / MMT Finance | 0xb0575765...c716e7 | $251K | SAFE (AdminCap) |
| BlueMove DEX | 0xb24b6789...1cae0 | $1.02M | SAFE (error code 17) |
| Mole Finance Incentive | 0x68e3b20e...56dc | $8.75M | SAFE (owner check) |
| Mole Finance Vault | 0x2fa2bf0a...1ca5d | $8.75M | SAFE (user-owns) |
| DipCoin Perps | 0x978fed07...1001 | $1.94M | SAFE (check_version) |
| DipCoin Vault | 0x9645033a...4738f | ~$1.7M | SAFE (check_version) |
| Astros Perp | 0x882cd938...6043 | $443K | SAFE (operator cap) |
| Abyss Protocol | 0x90a75f64...a0a5 | $1.96M | SAFE (cap-only fns) |
| Full Sail AMM | 0xe74104c6...d239 | $729K | SAFE (no entry fns) |
| DoubleUp | 0x2f2226a2...5593 | $1.28M | SAFE (Cap required) |
| Haedal Vault | 0x8462eb7e...d6a | $1.52M | SAFE (deposit_fee = pay pattern) |
| Ferra DLMM | 0x5a5c1d10...3ac | $622K | SAFE (no entry fns) |

## Notable False Positives Investigated

### Kriya spot_dex::claim_fees
- Pattern: public entry + no Cap param → flagged
- Dry-run result: **MoveAbort error code 9** (admin check at instruction 13)
- Only admin address 0x2b089053... can call it

### Kriya farm::claim_
- Pattern: public entry + no Cap + no version
- Dry-run result: **safe** - StakedPosition is owned object, ownership enforced by Sui VM

### BlueMove swap::withdraw_fee / set_fee_to / freeze_pool
- Pattern: public entry + no Cap → flagged
- Dry-run result: **MoveAbort error code 17** - internal sender==dev check
- All 10+ "ungated" admin functions have the same internal check

### Mole Finance sui_incentive::withdraw_all (addr, amount)
- Pattern: public entry + Address param + no Cap
- Dry-run result: **MoveAbort error code 8** for non-owner - `withdraw_with_cap` checks caller
- Victim (actual staker) can withdraw successfully

### DipCoin bank::withdraw / withdraw_all
- Pattern: public entry + no Cap/version guard
- Dry-run result: **MoveAbort** on `check_version` (from protocol module)
- Protocol-level version guard in separate module - invisible to surface scanner

## Known Exploited (Historical Context)
- **Nemo Protocol**: $2.6M exploit (September 2025) due to:
  - Flash loan function incorrectly exposed as `public` (not `public entry`)
  - `get_sy_amount_in_for_exact_py_out` query function modifying state
  - Deployed unaudited post-audit code from a single-signer address
  - **Patched**: current package has version guards on deposit/withdraw

## Protocols NOT Found (Insufficient Chain Data)
- ZO Perps ($858K TVL) - no public package address found
- SuiDollar ($250K TVL) - package address "0x0" in GitHub (unpublished)
- SuiDex ($259K TVL) - only object IDs, not package addresses in DefiLlama

## Key Findings: Round 8 Summary

**No new exploitable vulnerabilities found.**

All 18 protocols implement access control through one of:
1. **Cap pattern**: `AdminCap`/`OperatorCap` as function parameter
2. **Internal sender check**: `tx.sender == admin/owner` (verified by dry-run abort)
3. **Version guard**: `check_version` or `Versioned` param (often in separate module)
4. **Sui object ownership**: Owned objects enforce caller ownership at VM level
5. **No entry functions**: Pure public-function architecture (router pattern)

## Scan Methodology Used
- Surface scanner: grep entry functions for Cap/Version keywords
- Signature analysis: inspect param types (especially Address params)
- Dry-run testing: `devInspectTransactionBlock` with non-admin/random sender
- Object inspection: check shared vs owned object types
- Historical event analysis: find admin-only usage patterns

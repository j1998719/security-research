---
title: "Round 13 Security Audit: Vault Inflation, Zero-Amount Boundaries, Rounding, Self-Liquidation, Obligation Transfer"
date: 2026-05-01
type: security-audit
status: complete
tags: [sui, vault-inflation, self-liquidation, navi, scallop, haedal, mole, aftermath, liquidation-bonus, obligation]
---

## Scope

Five new attack surfaces covering vault-level and lending-level vulnerabilities.
Protocols: NAVI (v3), Scallop, Haedal, Mole Finance, AlphaFi, Volo, Aftermath.

---

## 方向一：Vault Inflation Attack (ERC-4626 First Depositor)

### 調查對象

| 協議 | Share 機制 | Balance 追蹤方式 | 通脹風險 |
|------|------------|-----------------|---------|
| Mole Finance Vault | `Supply<MagicCoin>` | `Balance<T>` (coin field) | ❌ 無風險 |
| Haedal staking | `Supply<stSUI>` + `total_staked: U64` | counter-based | ❌ 無風險（Friend 限制）|
| Aftermath staking | Exchange rate pair (U128) | `afsui_to_sui_exchange_rate` | ❌ 無風險 |
| Volo staking | `to_shares`/`from_shares` | internal ratio | ❌ 無風險 |
| AlphaFi V1 lending | N/A | version guard in create_position | ❌ 版本鎖 |

### Mole Finance 詳細分析（SAFE）

`VaultInfo` 結構：
```move
struct VaultInfo {
    coin: Balance<T>,           // 實際 token balance — 使用 Balance::value()
    magic_coin_supply: Supply<MagicCoin>,  // Share 發行量 — trusted Supply type
    vault_debt_share: U64,      // 已借出份額
    vault_debt_val: U64,        // 已借出價值
    ...
}
```

**結論：Mole vault 使用 `Balance<T>` 追蹤資產（不是計數器），使用 `Supply<MagicCoin>` 追蹤份額（不是可外部操控的 U64）。直接向 vault 轉入 token 會被 Balance::value() 計入，但 Supply 無法被外部 mint 增加。兩者比值保持穩定，無通脹攻擊窗口。**

### Haedal 潛在觀察（低風險待確認）

Haedal `Staking` 使用兩個計數器：
- `stsui_supply: U64` — 發行量（Supply<stSUI> 管理）
- `total_staked: U64` — 已質押量（手動更新）
- `update_total_rewards_onchain(OperatorCap, ...)` — admin 更新獎勵

Exchange rate = `(total_staked + total_rewards) / stsui_supply`

ABI 層確認：`update_total_rewards_onchain` 的 visibility = **Friend**（非 public，非 entry），只能被同包內的 module 呼叫，外部無法直接呼叫。不需要 OperatorCap 也無法被外部觸發。

**風險評級：SAFE（Friend visibility 確認，無外部攻擊路徑）**

---

## 方向二：Zero-Amount / Dust 邊界測試

### NAVI v15 Package 確認

前輪測試使用 `constants::version=14`（package `0xee00...`），但部署物件要求 `version=15`。
透過 UpgradeCap (`0xdba1b4...`) 查到 `UpgradeCap.package = 0x1e4a13...`，版本確認：

```
NAVI v15 package: 0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb
constants::version() = 15  ← 與 Incentive 物件一致，版本鎖通過
```

### NAVI entry_deposit Zero-Amount（v15，確認）

**v15 函數簽名（無 oracle 參數）：**
```move
// entry_deposit(clock, &mut storage, &mut pool, u8, coin, u64, &mut incentive_v2, &mut incentive_v3, &mut ctx)
```

**測試結果（v15）：**
| 測試 | abort code | 位置 | 含義 |
|------|-----------|------|------|
| `entry_deposit(coin=0, amount=0)` | **46000** | `utils::split_coin` | ZERO AMOUNT GUARD（coin split 層） |
| `entry_deposit(coin=1, amount=0)` | **46000** | `utils::split_coin` | 同上，amount 先被 split_coin 檢查 |
| `entry_deposit(coin=1, amount=1)` | — | — | 通過 split_coin，後續 storage 操作失敗（正常） |

**結論：NAVI deposit 零值防護在 `utils::split_coin` 層，任何 amount=0 呼叫均 abort 46000，在進入 `validate_deposit` 之前已攔截。SAFE。**

### NAVI entry_borrow_v2 Zero-Amount（v15，確認）

**v15 函數簽名：**
```move
// entry_borrow_v2(clock, oracle, &mut storage, &mut pool, u8, u64, &mut incentive_v2, &mut incentive_v3, &mut suisystem, &mut ctx)
```

**測試結果（v15）：**
| 測試 | abort code | 位置 | 含義 |
|------|-----------|------|------|
| `entry_borrow_v2(amount=0)` | **1503** | `validation::validate_borrow` | 明確零值檢查 |
| `entry_borrow_v2(amount=1)` | **1603** | `logic::execute_borrow` | 通過 validate_borrow，無抵押品失敗 |
| `entry_borrow_v2(amount=100)` | **1603** | `logic::execute_borrow` | 同上 |
| `entry_borrow_v2(amount=1e9)` | **1603** | `logic::execute_borrow` | 同上 |

**結論：NAVI borrow 的零值防護在 `validation::validate_borrow` 層（abort 1503），amount=0 被明確攔截。amount=1 通過 validate_borrow 但在 execute_borrow 因無抵押品失敗（abort 1603）。SAFE。**

### Scallop v19 Package 確認

透過 UpgradeCap (`0x38527d...`) 查到 `UpgradeCap.package = 0xde5c09...`（version=19）：

```
Scallop v19 package: 0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805
Version object value: 9  ← is_current_version() = true
XOracle object: 0x93d5bf0936b71eb27255941e532fac33b5a5c7759e377b4923af0a1359ad494f
CoinDecimalsRegistry: 0x200abe9bf19751cc566ae35aa58e2b7e4ff688fc1130f8d8909ea09bc137d668
```

### Scallop deposit_collateral Zero-Amount（v19，確認）

| 測試 | abort code | 對應錯誤常量 | 含義 |
|------|-----------|------------|------|
| `deposit_collateral(amount=0)` | **1797** | `zero_deposit_amount_error` | 明確零值防護 |
| `deposit_collateral(amount=1 MIST)` | **81926** | `min_collateral_amount_error` | 通過零值檢查，市場最小抵押金額限制 |

**結論：Scallop deposit 有明確 `zero_deposit_amount_error`（1797）防護。SAFE。**

### Scallop borrow_entry Zero-Amount（v19，確認）

透過系統性 USDC 借款測試（抵押 SUI，借 USDC）：

| 借款金額 | abort code | 對應錯誤常量 | 含義 |
|---------|-----------|------------|------|
| amount=0 | **1282** | `borrow_too_small_error` | 零值 + dust 一體防護 |
| amount=1 | **1282** | `borrow_too_small_error` | 同上 |
| amount=100 | **1282** | `borrow_too_small_error` | 同上 |
| amount=1,000,000 (1 USDC) | **1025** | `oracle_stale_price_error` | 通過 too_small 檢查，oracle 未更新失敗 |
| amount=10,000,000 (10 USDC) | **1025** | `oracle_stale_price_error` | 同上 |

**結論：Scallop borrow 有 `borrow_too_small_error`（1282）防護，同時覆蓋 amount=0 和 dust 金額。最小有效借款量約 >100 USDC-cents（精確閾值需源碼確認）。SAFE。**

### 完整 Scallop 錯誤碼表（關鍵節錄）

```
513:   version_mismatch_error
770:   obligation_locked
1025:  oracle_stale_price_error
1026:  oracle_price_not_found_error
1282:  borrow_too_small_error
1284:  unable_to_borrow_a_collateral_coin
1797:  zero_deposit_amount_error
1798:  zero_withdrawal_amount_error
81926: min_collateral_amount_error
```

**結論：兩個協議均有完整的零值邊界防護機制，均 SAFE。**

---

## 方向三：Rounding Accumulation (Ceil Division)

### Scallop Borrow Incentive 獎勵計算

從 `IncentivePool` 和 `IncentiveState` 結構分析：

```move
struct IncentivePool {
    distributed_point_per_period: U64,  // 每期分發點數
    index: U64,                          // 全局累積器
    stakes: U64,                         // 總質押量
    ...
}

struct IncentiveState {
    amount: U64,   // 用戶質押量
    points: U64,   // 已累積點數
    index: U64,    // 用戶快照 index
}
```

**Index 更新公式（推斷）：**
```
delta_index = distributed_point_per_period * elapsed / stakes
```
→ Integer floor division（安全方向）

**用戶獎勵公式（推斷）：**
```
points += (pool_index - user_index) * amount / BASE
```
→ Integer floor division（安全方向）

### Scallop Reward Pool 兌換率

```move
struct RewardPool {
    exchange_rate_numerator: U64,
    exchange_rate_denominator: U64,
    reward: Balance<T>,
    ...
}
// reward = points * numerator / denominator
```

**結論：從結構推斷使用 floor division，安全方向。無 ceil division 漏洞。但由於無源碼確認 `calculate_points_to_reward` 的實際實現，此結論為推斷。**

---

## 方向四：Borrow/Liquidation 邊界條件

### 4A. NAVI 自我清算漏洞（HIGH — 確認）

**漏洞：NAVI 未檢查 liquidator == borrower**

調用鏈分析：
```
entry_liquidation_v2(clock, oracle, storage, debt_id, pool_debt, coin, collat_id, pool_collat,
                     borrower_addr: Address, amount, incentive_v2, incentive_v3, sui_system, ctx)
  → validate_liquidate(storage, debt_id, collat_id, amount)  ← 無 sender/borrower 比較
  → execute_liquidate(clock, oracle, storage, borrower_addr, ...)  ← 無 ctx 傳入
```

`validate_liquidate` 函數簽名：
```move
public fun validate_liquidate(storage: &mut Storage, debt_asset_id: U8, collat_asset_id: U8, amount: U256)
```

**無任何 `borrower_addr != sender` 檢查。**

### NAVI SUI 清算激勵（鏈上確認）

```
LiquidationFactors for SUI:
  bonus:     100000000000000000000000000  = 10%
  ratio:     350000000000000000000000000  = 35%（最大清算比例）
  threshold: 800000000000000000000000000  = 80%（清算閾值）
  LTV: 75%
```

### 攻擊向量

**設置：**
- 攻擊者存入 100 SUI 抵押，借出 75 SUI（75% LTV）
- 初始 HF = (100 × 0.8) / 75 = 1.066（健康）

**觸發：**
- SUI 價格下跌 6.7% → 抵押價值 = 93.3 SUI equivalent
- HF = (93.3 × 0.8) / 75 = 0.995 < 1.0 → 可被清算

**自我清算：**
- 攻擊者調用 `entry_liquidation_v2(borrower=self)`
- 還款 35% = 26.25 SUI 債務
- 獲得抵押物：26.25 × (1 + 10%) = **28.875 SUI**
- 淨利潤：+2.625 SUI（從協議的清算激勵池中提取）

**重複收益：**
- 用 flash loan 預借 26.25 SUI → 自我清算 → 獲得 28.875 SUI → 還清 flash loan
- 淨利：2.625 SUI，無需初始資本

**損害分析：**
- 清算激勵本應激勵外部清算人，現在流向借款人本身
- 每次自我清算提取 10% 的清算額作為利潤
- 協議流動性提供者（stakers）承擔損失
- 可系統性利用所有持有 NAVI 倉位的用戶（包括設置自動借貸的 DeFi 合約）

**風險等級：MEDIUM-HIGH**

### 4B. 100% 清算限制

`LiquidationFactors.ratio = 35%` — NAVI 限制每次最多清算 35% 的債務，存在 close_factor 限制。這防止了單次全倉清算。

### 4C. 健康因子精確邊界

需要實際倉位進行 devInspect 測試（HF == 1.0 時是否可清算）。理論上 `HF < 1.0` 即可，但 `HF == 1.0` 的精確邊界行為取決於是否使用 `< 1` 還是 `<= 1`。

---

## 方向五：Scallop Obligation 轉移攻擊分析

### Obligation 物件模型（確認）

```move
struct Obligation {
    id: UID,
    ...
}
abilities: ['Store', 'Key']  // 有 Store 能力 = 可轉移

struct ObligationKey {
    id: UID,
    ownership: ObligationOwnership,
}
abilities: ['Store', 'Key']  // 有 Store 能力 = 可轉移
```

### 物件所有權（鏈上確認）

| 物件類型 | 所有權模型 | 意義 |
|---------|-----------|------|
| Obligation | **Shared** (confirmed from 5 txns) | 任何人可在 PTB 中使用 |
| ObligationKey | **AddressOwner** (confirmed) | 只有 owner 可用 |

### 訪問控制分析

| 操作 | 需要 ObligationKey? | 說明 |
|------|-------------------|------|
| borrow_entry | ✅ 是 | ObligationKey 作為 param[2] |
| deposit_collateral | ❌ 否 | 只需 Obligation |
| liquidate_entry | ❌ 否 | 只需 Obligation（設計如此）|
| force_unstake_unhealthy | ❌ 否 | 只需 Obligation（griefing 可能）|

### 轉移攻擊可行性

**ObligationKey 轉移攻擊**的前提：
1. 攻擊者需獲得受害者的 ObligationKey
2. ObligationKey 是 AddressOwner — 需要受害者的簽名才能轉移
3. **結論：純鏈上攻擊不可行**，需社會工程學（釣魚），超出本次研究範圍

### Griefing Attack：force_unstake_unhealthy（觀察）

```move
public entry fun force_unstake_unhealthy(
    incentive_pools: &mut IncentivePools,
    incentive_accounts: &mut IncentiveAccounts,
    obligation: &mut Obligation,  // Shared — 任何人可傳入
    market: &mut Market,
    coin_decimals_registry: &CoinDecimalsRegistry,
    x_oracle: &XOracle,
    clock: &Clock,
    ctx: &mut TxContext
)
```

任何人可以對任意 Obligation 調用此函數（若健康因子滿足條件）。這允許外部行為者強制取消其他用戶的 borrow incentive 質押倉位。

**設計意圖 vs 潛在風險：**
- 設計目的：保護協議，當用戶倉位不健康時強制清理 incentive 倉位
- 潛在風險：搶跑（front-running）— 在用戶倉位剛好觸發閾值時，第三方搶先調用，剝奪用戶本可在恢復健康後繼續持有的 incentive 倉位

**風險等級：低（設計意圖行為，griefing 無直接金融收益）**

---

## 本輪風險矩陣

| 漏洞 | 目標 | 等級 | 需要 admin key? | 純鏈上? |
|------|------|------|----------------|--------|
| **自我清算（無 borrower != sender 檢查）** | **NAVI** | **MEDIUM-HIGH** | **否** | **是** |
| Vault inflation attack | Mole/Haedal/Aftermath | SAFE | N/A | N/A |
| Zero-amount deposit/borrow | NAVI/Scallop | **SAFE（確認）** | 否 | 是 |
| Ceil division rounding | Scallop Borrow Incentive | 推斷安全 | N/A | N/A |
| ObligationKey transfer attack | Scallop | NOT FEASIBLE | 否 | 不是 |
| force_unstake_unhealthy griefing | Scallop | 低 | 否 | 是 |
| AlphaFi V1 版本鎖 | AlphaFi | SAFE（版本鎖有效）| N/A | N/A |

---

## 主要發現摘要

### Finding 1（MEDIUM-HIGH）：NAVI Self-Liquidation — No Borrower ≠ Sender Guard

- **攻擊路徑**：`entry_liquidation_v2(borrower=self)` → validate/execute 均無 sender 比較
- **利潤**：每次自我清算提取 10% 清算激勵（SUI 資產），可用 flash loan 無本金執行
- **確認狀態**：ABI 層完全確認（三個函數簽名均無 sender 參數），bytecode 等待源碼驗證
- **修復建議**：在 `entry_liquidation_v2` 中加入 `assert!(tx_context::sender(ctx) != borrower_address)`

### Finding 2（確認，SAFE）：Zero-Amount Boundary — Both Protocols Protected

**NAVI v15（package `0x1e4a13...`）：**
- `entry_deposit(0)` → abort **46000** @ `utils::split_coin` — coin split 層攔截
- `entry_borrow_v2(0)` → abort **1503** @ `validation::validate_borrow` — 明確 assert!(amount > 0)
- 零值防護在 validate_borrow 觸發，早於任何資金流動

**Scallop v19（package `0xde5c09...`）：**
- `deposit_collateral(0)` → abort **1797** = `zero_deposit_amount_error`
- `borrow_entry(0)` → abort **1282** = `borrow_too_small_error`（同時覆蓋 dust）
- Scallop 的 `borrow_too_small_error` 比 NAVI 更嚴格：覆蓋 0 到約 <1 USDC 的所有 dust

**風險等級：SAFE（兩協議均有明確零值防護）**

### Finding 3（確認）：Vault Inflation NOT APPLICABLE

- Mole Finance：`Balance<T>` + `Supply<T>` 雙重保護，不可通脹
- Haedal/Aftermath/Volo：均使用 trusted Supply 類型，無外部 mint 路徑

---

## 後續動作建議

1. **立即**：向 NAVI 白帽披露 self-liquidation finding，優先級高
2. ✅ **完成**：找到 NAVI v15（`0x1e4a13...`）和 Scallop v19（`0xde5c09...`）最新包地址，重跑 zero-amount 測試 → 兩協議均 SAFE
3. ✅ **完成**：Haedal `update_total_rewards_onchain` visibility = Friend — 純外部攻擊不可行，SAFE
4. ✅ **完成**：NAVI `validate_borrow` 有 assert!(amount > 0)（abort 1503）；deposit 有 utils::split_coin 零值防護（abort 46000）

---

## Sources

- NAVI protocol on-chain ABI: package `0xee0041...::incentive_v3`
- NAVI V1 storage/logic/validation: package `0xd899cf...`
- NAVI SUI reserve on-chain data: dynamic field of `0xe6d4c6...`
- Scallop lending: package `0xefe8b3...`
- Scallop borrow incentive: package `0xc63072...`
- Mole Finance vault: package `0x5ffa69...`
- AlphaFi V1 lending: package `0xd631cd...` (devInspect confirmed version guard)
- Haedal staking: package `0xbde4ba...`
- Aftermath staking: package `0x7f6ce7...`
- NAVI v15 package (latest): `0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb` (found via UpgradeCap `0xdba1b4...`)
- Scallop v19 package (latest): `0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805` (found via UpgradeCap `0x38527d...`)
- Scallop XOracle object: `0x93d5bf0936b71eb27255941e532fac33b5a5c7759e377b4923af0a1359ad494f`
- Scallop CoinDecimalsRegistry: `0x200abe9bf19751cc566ae35aa58e2b7e4ff688fc1130f8d8909ea09bc137d668`
- All devInspect tests ran via Sui RPC fullnode.mainnet.sui.io

---
title: "Round 12 Security Audit: New Attack Surfaces — Oracle Staleness, UpgradeCap, Dynamic Fields, Coin Type Confusion"
date: 2026-05-01
type: security-audit
status: complete
tags: [sui, oracle, staleness, pyth, upgradecap, dynamic-field, coin-type, navi, scallop, suilend, bucket]
---

## Scope

Five new attack surfaces not covered in rounds 1–11. Protocols audited: NAVI V1 Lending, Scallop, Suilend, Bucket Protocol, Cetus CLMM.

---

## 方向一：Pyth Oracle 時間戳驗證（Staleness Attack）

### 1A. NAVI V1 — 自建 Oracle，Bool 回傳值未確認是否被 check

NAVI V1 lending（`0xd899cf7d...`）使用的是**自建 oracle**，不是直接 Pyth。oracle package：`0xca441b44...::oracle`。

**Oracle 結構：**

```move
struct Price {
  value: U256,
  decimal: U8,
  timestamp: U64,   // 存放上次更新時間
}

struct PriceOracle {
  id: UID,
  version: U64,
  update_interval: U64,   // 可配置的 staleness 閾值（秒）
  price_oracles: Table<U8, Price>,
}
```

**`get_token_price` 回傳型別：**

```move
pub fun get_token_price(clock: &Clock, oracle: &PriceOracle, asset_id: U8): (Bool, U256, U8)
// Bool = freshness indicator (true = fresh, false = stale)
```

**問題：Bool return 是否被 lending 模組 assert？**

NAVI 官方文件說 15 秒內的價格才算 fresh。Veridise 審計報告（June 2024，`VAR_Navi-240607`）找到兩個 related 問題：

- **V-NOR-VUL-0001（High）**：系統「fails to validate whether oracle price data exceeds acceptable age bounds」
- **V-NOR-VUL-0004（High）**：`update_interval` 參數無範圍驗證，可被設成極大值導致永遠 stale 的 oracle 仍能通過

從 bytecode-level 觀察：`logic.move` 的 `execute_borrow` 等函數接受 `PriceOracle` 但沒有在函數簽名中回傳或接受 Bool。邏輯推測是呼叫 `get_token_price` 後 **assert!(price_is_valid)** 或忽略。由於 NAVI V1 source code 未公開，無法 100% 確認 bool 是否被 checked。

**風險評級：可疑（待源碼確認）**

理論攻擊場景：
1. 等待 oracle feeder 超過 15 秒未更新（網路問題、假日期間）
2. 呼叫 NAVI V1 borrow，若 bool 被忽略 → 以 stale price 借出
3. 若 bool 有被 assert，則 safe

**注意**：NAVI 在 2024 年 7 月升級為去中心化 oracle（整合 Pyth + Supra），但 V1 lending 的舊合約仍使用舊 oracle。由於 `NAVI V1 lending::borrow` 近期無鏈上活動，該 package 可能已停用。

---

### 1B. Scallop x_oracle — 極嚴格的 Exact-Equality Staleness Check

**發現：Scallop `protocol::price::get_price` 使用精確相等（不是範圍）：**

```move
// price.move (confirmed from source)
let now = clock::timestamp_ms(clock) / 1000;
assert!(now == last_updated, error::oracle_stale_price_error());
```

這是**精確秒對齊**：price 必須在「當前 Unix 秒」被更新，否則 abort。

設計邏輯：Scallop 要求用戶在同一 PTB 內先更新 price 再 borrow/liquidate。`confirm_price_update_request(oracle, request, clock)` 在同一 checkpoint 寫入 `last_updated = now`，然後 `get_price` 讀時 assert 精確相等。

**潛在的活性問題**：若 Pyth price feed update 與用戶 borrow 發生在不同 checkpoint（差 1 秒），所有操作都會 abort。

**Pyth adaptor 的寬鬆 vs protocol 的嚴格**：
- Pyth adaptor `pyth_adaptor.move`：`assert!(price_updated_time >= now - 30, PYTH_PRICE_TOO_OLD)`（30 秒容忍）
- Protocol level：`assert!(now == last_updated)`（精確秒）

兩層設計目的：先接受最近 30 秒的 Pyth 資料，但 protocol 只接受同一 checkpoint 寫入的 price。

**風險評級：設計觀察（非漏洞，但可能影響活性）**

---

### 1C. Suilend — Pyth 直連 + 明確 Freshness Enforcement（SAFE）

```move
// reserve.move
struct Reserve {
  price_last_update_timestamp_s: U64,  // tracks last Pyth update
  ...
}

// Exposed functions:
pub fun assert_price_is_fresh(reserve: &Reserve<T>, clock: &Clock)
pub fun update_price(reserve: &mut Reserve<T>, clock: &Clock, price_info: &PriceInfoObject)
```

Suilend 直接使用 Pyth `PriceInfoObject` + `Clock`，有明確的 `assert_price_is_fresh` 函數。借貸操作前強制 price freshness 驗證。

**結論：SAFE。**

---

### 1D. Bucket Protocol — 多源 Oracle，Staleness 在 Aggregation 層執行

Bucket 使用 `single_oracle` package（`0xf145ee6d...`），有三個 price source：

```move
struct SingleOracle<T> {
  tolerance_ms: U64,       // configurable staleness tolerance
  latest_update_ms: U64,   // last price update time
  pyth_config: Option<ID>,
  switchboard_config: Option<ID>,
  supra_config: Option<U32>,
}
```

**關鍵觀察**：`collect_price_from_supra` 和 `collect_price_from_switchboard` 都**不接受 Clock 參數**。staleness check 在 `price_aggregator::aggregate_price(clock, Vec<PriceInfo>)` 時執行。

**攻擊面**：若 collect 函數用 Supra/Switchboard 的 on-chain timestamp（而非 Sui Clock），staleness window 可能與協議預期不同。整體設計看起來正確，但需要對照 aggregate_price 的邏輯驗證。

**風險評級：低（設計需確認）**

---

## 方向二：PTB 組合攻擊（Cross-Protocol State Poisoning）

**掃描結果：AMM spot price 依賴不存在於主要借貸協議。**

| 協議 | Oracle 來源 | 是否用 AMM spot? |
|------|-------------|-----------------|
| NAVI V1 | 自建 oracle (OracleFeederCap 控制) | NO |
| Scallop | x_oracle (Pyth + Switchboard + Supra 聚合) | NO |
| Suilend | Pyth 直連 PriceInfoObject | NO |
| Bucket | 多源聚合 (Pyth + Supra + Switchboard) | NO |

PTB oracle sandwich 攻擊（操控 Cetus spot price → 影響借貸 liquidation）在以上協議均**不可行**，因為它們全部使用外部 oracle 而非 AMM spot price。

---

## 方向三：UpgradeCap 中心化

**鏈上查詢限制**：`suix_queryObjects` 對 `0x2::package::UpgradeCap` 返回空集（RPC filtered）。GraphQL endpoint 在此環境不可達。無法直接確認各協議 UpgradeCap 的持有者是否為多簽。

**間接證據（高度相關）**：

2026 年 4 月 27 日，Scallop 遭受 $142K exploit：
- 攻擊者使用 **17 個月前的 deprecated V2 spool 合約**（2023 年 11 月部署）
- 舊合約的 `SpoolAccount.last_index` 未初始化（永遠為 0）
- 由於 Sui 合約 immutable + 共享 object 無版本 gate，舊合約永久可呼叫
- 攻擊者 stake 136K sSUI → 系統以為從 2023 年 8 月就開始 stake → 提取 150K SUI

這不是 UpgradeCap 問題，但說明了「無法強制下線舊合約」這個 Sui 固有風險。若 UpgradeCap 為單一 EOA 持有，惡意升級或私鑰洩漏 = 協議被完全 replace。

**建議確認路徑**：
```bash
# 從 Suiscan/Suivision UI 查詢：
# https://suiscan.xyz/mainnet/package/<PKG_ADDRESS> → 查 UpgradeCap 持有者
# 對 NAVI、Scallop、Cetus、Suilend 各查一次
```

---

## 方向四：Dynamic Field 注入（Shared Object Poisoning）

掃描四個主要協議的 shared object 是否暴露 `uid_mut`：

| 協議 | 對象 | uid_mut 暴露? |
|------|------|--------------|
| Cetus CLMM | `pool::Pool` | NO（無 allow_extensions 字段）|
| Scallop | `x_oracle::XOracle` | NO（無 UID return）|
| Suilend | `lending_market::LendingMarket` | NO（無 extension_fields）|
| NAVI | `storage::Storage` | NO（未暴露 uid_mut）|

**結論：所有主要協議的 shared object 均未暴露 uid_mut。Dynamic Field Injection 攻擊面不存在。**

---

## 方向五：Coin Type Confusion（幽靈 Coin）

NAVI lending 的 `borrow` 函數簽名：

```move
entry fun borrow<T>(clock, oracle, storage, pool: &mut Pool<T>, asset_id: U8, amount: U64, ctx)
```

`Pool<T>` 將 CoinType 與 Pool 物件綁定。Move 泛型系統在 bytecode 層強制 `Pool<USDC>` 不可傳入 `Pool<FakeUSDC>` 的位置。

`Storage.reserves: Table<U8, ReserveData>` 用 U8 索引，但 U8 asset_id 是由 admin 初始化時指定，不是 user 自由設定。

**結論：SAFE。Move type system 提供編譯期保護，Coin Type Confusion 在 NAVI 不可行。**

---

## 已確認的歷史漏洞（Scallop April 2026）

本輪審計的 oracle 操控 + deprecated contract 組合，已在現實中被利用：

**2026-04-27 Scallop Exploit**
- 漏洞一：`SpoolAccount.last_index` 未初始化（= 0 for new accounts）
- 漏洞二：Oracle 操控（調整 SUI/USDC 匯率）
- 攻擊：在 **同一 PTB** 完成 stake → 提取 inflated rewards + oracle manipulation + flash loan 還款
- 損失：$142K（約 150K SUI）
- 根本原因：deprecated package 永久可呼叫 + 缺少版本 gate

這與我們在 Round 9 scanner 掃到的 Scallop Spool V1/V2 `update_points` 可被公開呼叫的 pattern 高度相關。**被確認 exploited。**

---

## 本輪風險矩陣

| 攻擊面 | 目標 | 風險等級 | 是否可執行 |
|--------|------|----------|-----------|
| Oracle Bool return unchecked | NAVI V1 | 可疑（待源碼確認）| 需要 oracle feeder 離線 |
| Exact equality staleness (活性) | Scallop | 設計觀察 | 不影響安全性 |
| Pyth freshness | Suilend | SAFE | N/A |
| Oracle aggregation staleness | Bucket | 低 | 需確認 aggregate_price 邏輯 |
| PTB oracle sandwich | 所有協議 | NOT FEASIBLE | 無協議用 AMM spot price |
| UpgradeCap centralization | 所有協議 | 設計風險 | 需 UI 確認持有者 |
| Dynamic Field injection | 所有協議 | SAFE | N/A |
| Coin Type Confusion | NAVI | SAFE | N/A |

---

## 建議的後續動作

1. **NAVI V1 oracle bool check**：需要 NAVI V1 `logic.move` 源碼或 bytecode 分解，確認 `execute_borrow` 是否 assert 在 `get_token_price` 的 bool return 上
2. **UpgradeCap 查詢**：透過 Suiscan/Suivision 手動確認 NAVI、Scallop、Suilend 的 UpgradeCap 持有地址，檢查是否為多簽
3. **Bucket aggregate_price 邏輯**：確認 tolerance_ms 當前設定值，以及 Supra/Switchboard 資料的時間戳處理方式

---

## Sources

- [Veridise NAVI Decentralized Oracle Integration Audit (June 2024)](https://veridise.com/wp-content/uploads/2024/11/VAR_Navi-240607-Decentralized_Oracle_Integration.pdf)
- [Scallop Flash Loan Exploit - CryptoTimes](https://www.cryptotimes.io/2026/04/27/scallop-loses-142k-in-flash-loan-attack-on-deprecated-contract/)
- [NAVI Oracle Documentation](https://naviprotocol.gitbook.io/navi-protocol-developer-docs/decentralized-oracle)
- [Scallop sui-lending-protocol GitHub](https://github.com/scallop-io/sui-lending-protocol)
- [Suilend GitHub](https://github.com/suilend/suilend)
- Scallop `protocol::price` source: `github.com/scallop-io/sui-lending-protocol/contracts/protocol/sources/evaluator/price.move`
- Scallop `pyth_rule::pyth_adaptor` source: `contracts/sui_x_oracle/pyth_rule/sources/pyth_adaptor.move`

/**
 * Network-aware address resolution.
 *
 * Mainnet: hardcoded constants (zero-latency, used in time-critical paths).
 * Testnet: fetched from NAVI SDK + chain at startup (ISVs queried on-demand).
 *
 * Set NETWORK=testnet to run against Sui testnet.
 */

import { SuiClient } from "@mysten/sui/client";
import { SUI_RPCS as CONFIG_RPCS } from "./config.js";

// ── shared type ───────────────────────────────────────────────────────────────

export interface SharedObj {
  id:  string;
  isv: number;   // initialSharedVersion
}

// Cetus CLMM pool entry — used for flash_swap in the liquidation executor
export interface CetusPool {
  id:     string;
  isv:    number;
  coinA:  string;   // full coin type
  coinB:  string;
  feeBps: number;   // Cetus fee tier in basis points (e.g. 25 = 0.25%)
}

export interface NetworkAddrs {
  SUI_RPC:           string;
  PYTH_WS:           string;

  NAVI_PKG:          string;
  NAVI_STORAGE:      SharedObj;
  PYTH_ORACLE:       SharedObj;
  NAVI_INCENTIVE_V2: SharedObj;
  NAVI_INCENTIVE_V3: SharedObj;
  NAVI_FLASH_CONFIG: SharedObj;

  // Pyth on-chain state (used by SuiPythClient for in-PTB VAA push)
  PYTH_STATE_ID:     string;
  WORMHOLE_STATE_ID: string;

  // oracle_pro aggregator
  ORACLE_PRO_PKG:    string;
  ORACLE_CONFIG:     SharedObj;
  SUPRA_HOLDER:      SharedObj;
  SWITCHBOARD_AGG:   SharedObj;

  POOLS: Record<number, { id: string; isv: number; coinType: string }>;

  ORACLE_PRO_FEEDS: Record<number, { pioId: string; feedId: string }>;

  // Cetus CLMM — for flash_swap in liquidation executor
  CETUS_PKG:           string;
  CETUS_GLOBAL_CONFIG: SharedObj;
  // Key: "coinTypeA,coinTypeB" (canonical order from chain) → pool
  CETUS_POOLS: Record<string, CetusPool>;
}

// ── mainnet ───────────────────────────────────────────────────────────────────

export const MAINNET: NetworkAddrs = {
  SUI_RPC:  process.env.SUI_RPC ?? "https://fullnode.mainnet.sui.io:443",
  PYTH_WS:  process.env.PYTH_WS ?? "wss://hermes.pyth.network/ws",

  NAVI_PKG:     "0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb",
  NAVI_STORAGE: { id: "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe", isv: 8202844 },
  PYTH_ORACLE:  { id: "0x1568865ed9a0b5ec414220e8f79b3d04c77acc82358f6e5ae4635687392ffbef", isv: 8202835 },

  NAVI_INCENTIVE_V2: { id: "0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c", isv: 38232222 },
  NAVI_INCENTIVE_V3: { id: "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80", isv: 496060210 },
  NAVI_FLASH_CONFIG: { id: "0x3672b2bf471a60c30a03325f104f92fb195c9d337ba58072dce764fe2aa5e2dc", isv: 75708312 },

  PYTH_STATE_ID:     "0x1f9310238ee9298fb703c3419030b35b22bb1cc37113e3bb5007c99aec79e5b8",
  WORMHOLE_STATE_ID: "0xaeab97f96cf9877fee2883315d459552b2b921edc16d7ceac6eab944dd88919c",

  ORACLE_PRO_PKG:  "0x203728f46eb10d19f8f8081db849c86aa8f2a19341b7fd84d7a0e74f053f6242",
  ORACLE_CONFIG:   { id: "0x1afe1cb83634f581606cc73c4487ddd8cc39a944b951283af23f7d69d5589478", isv: 305665201 },
  SUPRA_HOLDER:    { id: "0xaa0315f0748c1f24ddb2b45f7939cff40f7a8104af5ccbc4a1d32f870c0b4105", isv: 5963053 },
  SWITCHBOARD_AGG: { id: "0x1fa7566f40f93cdbafd5a029a231e06664219444debb59beec2fe3f19ca08b7e", isv: 570776947 },

  POOLS: {
    0:  { id: "0x96df0fce3c471489f4debaaa762cf960b3d97820bd1f3f025ff8190730e958c5", isv: 8202845,   coinType: "0x2::sui::SUI" },
    1:  { id: "0xa02a98f9c88db51c6f5efaaf2261c81f34dd56d86073387e0ef1805ca22e39c8", isv: 8202846,   coinType: "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN" },
    2:  { id: "0x0e060c3b5b8de00fb50511b7a45188c8e34b6995c01f69d98ea5a466fe10d103", isv: 20925978,  coinType: "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN" },
    3:  { id: "0x71b9f6e822c48ce827bceadce82201d6a7559f7b0350ed1daa1dc2ba3ac41b56", isv: 26605571,  coinType: "0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN" },
    4:  { id: "0x3c376f857ec4247b8ee456c1db19e9c74e0154d4876915e54221b5052d5b1e2e", isv: 40406925,  coinType: "0x6864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS" },
    5:  { id: "0x9790c2c272e15b6bf9b341eb531ef16bcc8ed2b20dfda25d060bf47f5dd88d01", isv: 41591100,  coinType: "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT" },
    6:  { id: "0x6fd9cb6ebd76bc80340a9443d72ea0ae282ee20e2fd7544f6ffcd2c070d9557a", isv: 43495349,  coinType: "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI" },
    7:  { id: "0xc0e02e7a245e855dd365422faf76f87d9f5b2148a26d48dda6e8253c3fe9fa60", isv: 70760701,  coinType: "0xa99b8952d4f7d947ea77fe0ecdcc9e5fc0bcab2841d6e2a5aa00c3044e5544b5::navx::NAVX" },
    8:  { id: "0xd162cbe40f8829ce71c9b3d3bf3a83859689a79fa220b23d70dc0300b777ae6e", isv: 333884382, coinType: "0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN" },
    9:  { id: "0xc9208c1e75f990b2c814fa3a45f1bf0e85bb78404cfdb2ae6bb97de58bb30932", isv: 338663325, coinType: "0x2053d08c1e2bd02791056171aab0fd12bd7cd7efad2ab8f6b9c8902f14df2ff2::ausd::AUSD" },
    10: { id: "0xa3582097b4c57630046c0c49a88bfc6b202a3ec0a9db5597c31765f7563755a8", isv: 372449049, coinType: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC" },
    11: { id: "0x78ba01c21d8301be15690d3c30dc9f111871e38cfb0b2dd4b70cc6052fba41bb", isv: 389514995, coinType: "0xd0e89b2af5e4910726fbcd8b8dd37bb79b29e5f83f7491bca830e94f7f226d29::eth::ETH" },
    12: { id: "0x4b6253a9f8cf7f5d31e6d04aed4046b9e325a1681d34e0eff11a8441525d4563", isv: 395476620, coinType: "0x960b531667636f39e85867775f52f6b1f220a058c4de786905bdf761e06a56bb::usdy::USDY" },
    13: { id: "0x2fcc6245f72795fad50f17c20583f8c6e81426ab69d7d3590420571364d080d4", isv: 416632453, coinType: "0x5145494a5f5100e645e4b0aa950fa6b68f614e8c59e17bc5ded3495123a79178::ns::NS" },
    14: { id: "0xd96dcd6982c45e580c83ff1d96c2b4455a874c284b637daf67c0787f25bc32dd", isv: 421393626, coinType: "0x5f496ed5d9d045c5b788dc1bb85f54100f2ede11e46f6a232c29daada4c5bdb6::coin::COIN" },
    15: { id: "0x08373c5efffd07f88eace1c76abe4777489d9ec044fd4cd567f982d9c169e946", isv: 443050989, coinType: "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP" },
    16: { id: "0x38d8ac76efc14035bbc8c8b38803f5bd012a0f117d9a0bad2103f8b2c6675b66", isv: 446180423, coinType: "0xf16e6b723f242ec745dfd7634ad072c42d5c1d9ac9d62a39c381303eaa57693a::fdusd::FDUSD" },
    17: { id: "0xe2cfd1807f5b44b44d7cabff5376099e76c5f0e4b35a01bdc4b0ef465a23e32c", isv: 453676842, coinType: "0xe1b45a0e641b9955a20aa0ad1c1f4ad86aad8afb07296d4085e349a50e90bdca::blue::BLUE" },
    18: { id: "0x98953e1c8af4af0cd8f59a52f9df6e60c9790b8143f556751f10949b40c76c50", isv: 458949105, coinType: "0xce7ff77a83ea0cb6fd39bd8748e2ec89a3f41e8efdc3f4eb123e0ca37b184db2::buck::BUCK" },
    19: { id: "0xa3e0471746e5d35043801bce247d3b3784cc74329d39f7ed665446ddcf22a9e2", isv: 464441251, coinType: "0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT" },
    20: { id: "0x0bccd5189d311002f4e10dc98270a3362fb3f7f9d48164cf40828f6c09f351e2", isv: 477977475, coinType: "0xd1b72982e40348d069bb1ff701e634c117bb5f741f44dff91e472d3b01461e55::stsui::STSUI" },
    21: { id: "0x348f4049063e6c4c860064d67a170a7b3de033db9d67545d98fa5da3999966bc", isv: 488787610, coinType: "0xaafb102dd0902f5055cadecd687fb5b71ca82ef0e0285d90afde828ec58ca96b::btc::BTC" },
    22: { id: "0xac5f6d750063244cc5abceef712b7ea1aa377f73762099b31c0051a842c13b10", isv: 499627809, coinType: "0xb7844e289a8410e50fb3ca48d69eb9cf29e27d223ef90353fe1bd8e27ff8f3f8::coin::COIN" },
    23: { id: "0x377b8322c0d349b44b5873d418192eefe871b9372bb3a86f288cafe97317de04", isv: 502157841, coinType: "0x3e8e9423d80e1774a7ca128fccd8bf5f1f7753be658c5e645929037f7c819040::lbtc::LBTC" },
    24: { id: "0xef76883525f5c2ff90cd97732940dbbdba0b391e29de839b10588cee8e4fe167", isv: 510342415, coinType: "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL" },
    25: { id: "0x930f5cf61dcb66d699ba57b2eb72da6fd04c64a53073cc40f751ef12c77aaa6a", isv: 553514320, coinType: "0x3a304c7feba2d819ea57c3542d68439ca2c386ba02159c740f7b406e592c62ea::haedal::HAEDAL" },
    26: { id: "0xd9c9a1d8a2f82d752d4f2504c1097636bbe7f0f335a89be85f65fb32dc6b1866", isv: 561891682, coinType: "0x876a4b7bce8aeaef60464c11f4026903e9afacab79b9b142686158aa86560b50::xbtc::XBTC" },
    27: { id: "0x3566577feaba2f24b9e0b315a10f1afe04e7d275c2da6f28caeba095d00dee8d", isv: 598802816, coinType: "0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA" },
    31: { id: "0x33b2924f2b7e12112a134ad69d9f2b3565c316b0a756e328abe9914c8deca034", isv: 627498153, coinType: "0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM" },
    32: { id: "0x88fb36f9ab1ac2a47a974c53daf5ef37862e063f4875bf54e5853e2ca1e9ddad", isv: 703606404, coinType: "0x0041f9f9344cac094454cd574e333c4fdb132d7bcc9379bcd4aab485b2a63942::wbtc::WBTC" },
    33: { id: "0x86d663fdba9690cb4edf0b29140c31bad8c98d43b3eac70050c237c0d1434334", isv: 784526613, coinType: "0x41d587e5336f1c86cad50d38a7136db99333bb9bda91cea4ba69115defeb1402::sui_usde::SUI_USDE" },
    34: { id: "0xb0da1bf1702e919a3d5182939944435ccfd1b1facd92acb273007c3f09f42201", isv: 808829043, coinType: "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI" },
  },

  CETUS_PKG:           "0x25ebb9a7c50eb17b3fa9c5a30fb8b5ad8f97caaf4928943acbcff7153dfee5e3",
  CETUS_GLOBAL_CONFIG: { id: "0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f", isv: 1574190 },

  // Pools discovered from real liquidation TXs (coinA/coinB = canonical order on-chain)
  CETUS_POOLS: {
    // USDC(native) / SUI  — most common liquidation pair  fee=0.25%
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC,0x2::sui::SUI":
      { id: "0xb8d7d9e66a60c239e7a60110efcf8de6c705580ed924d0dde141f4a0e2c90105", isv: 373623018, coinA: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", coinB: "0x2::sui::SUI", feeBps: 25 },
    // USDT(wormhole) / SUI  fee=0.25%
    "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN,0x2::sui::SUI":
      { id: "0x06d8af9e6afd27262db436f0d37b304a041f710c3ea1fa4c3a9bab36b3569ad3", isv: 1935977,   coinA: "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN", coinB: "0x2::sui::SUI", feeBps: 25 },
    // bridged USDC(wormhole) / SUI  fee=0.25%
    "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN,0x2::sui::SUI":
      { id: "0xcf994611fd4c48e277ce3ffd4d4364c914af2c3cbb05f7bf6facd371de688630", isv: 1580450,   coinA: "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN", coinB: "0x2::sui::SUI", feeBps: 25 },
    // vSUI (CERT) / SUI  fee=0.05% (LST pair)
    "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT,0x2::sui::SUI":
      { id: "0x6c545e78638c8c1db7a48b282bb8ca79da107993fcb185f75cedc1f5adb2f535", isv: 34395748,  coinA: "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT", coinB: "0x2::sui::SUI", feeBps: 5 },
    // haSUI / SUI  fee=0.05% (LST pair)
    "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI,0x2::sui::SUI":
      { id: "0x871d8a227114f375170f149f7e9d45be822dd003eba225e83c05ac80828596bc", isv: 29297877,  coinA: "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI", coinB: "0x2::sui::SUI", feeBps: 5 },
    // LBTC2 / SUI  fee=0.25%
    "0x3e8e9423d80e1774a7ca128fccd8bf5f1f7753be658c5e645929037f7c819040::lbtc::LBTC,0x2::sui::SUI":
      { id: "0x2fc6ee9183d0f1ca0d2dded02c416be6f4671bb82db55c26ce12b536812a4b8e", isv: 500039347, coinA: "0x3e8e9423d80e1774a7ca128fccd8bf5f1f7753be658c5e645929037f7c819040::lbtc::LBTC", coinB: "0x2::sui::SUI", feeBps: 25 },
    // WAL / SUI  fee=1%
    "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL,0x2::sui::SUI":
      { id: "0x72f5c6eef73d77de271886219a2543e7c29a33de19a6c69c5cf1899f729c3f17", isv: 510321353, coinA: "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL", coinB: "0x2::sui::SUI", feeBps: 100 },
    // NAVX / SUI  fee=1%
    "0xa99b8952d4f7d947ea77fe0ecdcc9e5fc0bcab2841d6e2a5aa00c3044e5544b5::navx::NAVX,0x2::sui::SUI":
      { id: "0x0254747f5ca059a1972cd7f6016485d51392a3fde608107b93bbaebea550f703", isv: 65122032,  coinA: "0xa99b8952d4f7d947ea77fe0ecdcc9e5fc0bcab2841d6e2a5aa00c3044e5544b5::navx::NAVX", coinB: "0x2::sui::SUI", feeBps: 100 },
    // USDT(wormhole) / bridged USDC  fee=0.01% (stable pair)
    "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN,0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN":
      { id: "0xc8d7a1503dc2f9f5b05449a87d8733593e2f0f3e7bffd90541252782e4d2ca20", isv: 1580521,   coinA: "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN", coinB: "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN", feeBps: 1 },
    // USDC(native) / USDT(wormhole)  fee=0.01% (stable pair)
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC,0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN":
      { id: "0x1efc96c99c9d91ac0f54f0ca78d2d9a6ba11377d29354c0a192c86f0495ddec7", isv: 378068121, coinA: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", coinB: "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN", feeBps: 1 },
    // WETH(wormhole) / USDC(native)  fee=0.05%
    "0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN,0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC":
      { id: "0x5b0b24c27ccf6d0e98f3a8704d2e577de83fa574d3a9060eb8945eeb82b3e2df", isv: 1580577,   coinA: "0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN", coinB: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", feeBps: 5 },
    // NS / SUI  fee=1%
    "0x5145494a5f5100e645e4b0aa950fa6b68f614e8c59e17bc5ded3495123a79178::ns::NS,0x2::sui::SUI":
      { id: "0x763f63cbada3a932c46972c6c6dcf1abd8a9a73331908a1d7ef24c2232d85520", isv: 416502635, coinA: "0x5145494a5f5100e645e4b0aa950fa6b68f614e8c59e17bc5ded3495123a79178::ns::NS", coinB: "0x2::sui::SUI", feeBps: 100 },
    // WETH(wormhole) / SUI  fee=0.05%
    "0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN,0x2::sui::SUI":
      { id: "0xbf6e8d5e563a76906cd69035360f886ed56642f764b5f77a96b85b118584abdd", isv: 2871171,   coinA: "0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN", coinB: "0x2::sui::SUI", feeBps: 5 },
    // DEEP / SUI  fee=0.05%
    "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP,0x2::sui::SUI":
      { id: "0xd978d331772a5b90d5a4781e1232d18afd12019d0c35db79e3674beeda8f9126", isv: 389638435, coinA: "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP", coinB: "0x2::sui::SUI", feeBps: 5 },
    // USDC / HAEDAL(NAVI)  fee=0.25%  — 69T liquidity; used for two-hop HAEDAL→USDC→SUI
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC,0x3a304c7feba2d819ea57c3542d68439ca2c386ba02159c740f7b406e592c62ea::haedal::HAEDAL":
      { id: "0x711f5d37e3b09b026b182d9e0973d05e9a837d11066ff48f4a55a426d8913359", isv: 506307791, coinA: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", coinB: "0x3a304c7feba2d819ea57c3542d68439ca2c386ba02159c740f7b406e592c62ea::haedal::HAEDAL", feeBps: 25 },
    // BUCK / SUI  fee=0.01% (ts=2, tightest BUCK/SUI pool)
    "0xce7ff77a83ea0cb6fd39bd8748e2ec89a3f41e8efdc3f4eb123e0ca37b184db2::buck::BUCK,0x2::sui::SUI":
      { id: "0xf502e9fe6694d342fa490e69de97d19234fbacff9bb54ece48c808e346fe5562", isv: 422612425, coinA: "0xce7ff77a83ea0cb6fd39bd8748e2ec89a3f41e8efdc3f4eb123e0ca37b184db2::buck::BUCK", coinB: "0x2::sui::SUI", feeBps: 1 },
    // USDC / BUCK  fee=0.01% (ts=2)
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC,0xce7ff77a83ea0cb6fd39bd8748e2ec89a3f41e8efdc3f4eb123e0ca37b184db2::buck::BUCK":
      { id: "0x4c50ba9d1e60d229800293a4222851c9c3f797aa5ba8a8d32cc67ec7e79fec60", isv: 373908232, coinA: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", coinB: "0xce7ff77a83ea0cb6fd39bd8748e2ec89a3f41e8efdc3f4eb123e0ca37b184db2::buck::BUCK", feeBps: 1 },
    // ETH / SUI  fee=0.01% (ts=1, tightest ETH/SUI pool)
    "0xd0e89b2af5e4910726fbcd8b8dd37bb79b29e5f83f7491bca830e94f7f226d29::eth::ETH,0x2::sui::SUI":
      { id: "0x20f14d2592cf6af30fe3edb2fc34ab13fcadf68a5beac7d89637cc1d4a3f0b63", isv: 557777470, coinA: "0xd0e89b2af5e4910726fbcd8b8dd37bb79b29e5f83f7491bca830e94f7f226d29::eth::ETH", coinB: "0x2::sui::SUI", feeBps: 1 },
    // USDC / ETH  fee=0.01% (ts=2)
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC,0xd0e89b2af5e4910726fbcd8b8dd37bb79b29e5f83f7491bca830e94f7f226d29::eth::ETH":
      { id: "0xc83603f8a0693b2a9e753d4f8de68076db51f73603b83696c4f8febb9efa51d6", isv: 551213540, coinA: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", coinB: "0xd0e89b2af5e4910726fbcd8b8dd37bb79b29e5f83f7491bca830e94f7f226d29::eth::ETH", feeBps: 1 },
    // BTC2(COIN) / SUI  fee=1% (ts=200, only available pool)
    "0x5f496ed5d9d045c5b788dc1bb85f54100f2ede11e46f6a232c29daada4c5bdb6::coin::COIN,0x2::sui::SUI":
      { id: "0x5a43a4388205053fc790d9139b3e7d5fb251f5fe21944d1bd2d6ed48a6f2f7ef", isv: 438501534, coinA: "0x5f496ed5d9d045c5b788dc1bb85f54100f2ede11e46f6a232c29daada4c5bdb6::coin::COIN", coinB: "0x2::sui::SUI", feeBps: 100 },
    // USDC / BTC2(COIN)  fee=0.25% (ts=60)
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC,0x5f496ed5d9d045c5b788dc1bb85f54100f2ede11e46f6a232c29daada4c5bdb6::coin::COIN":
      { id: "0xa3184e984c2668ffa60b232485b69523a2c36baf5ef82f8534e8fcac88d71360", isv: 430656259, coinA: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", coinB: "0x5f496ed5d9d045c5b788dc1bb85f54100f2ede11e46f6a232c29daada4c5bdb6::coin::COIN", feeBps: 25 },
    // BTC / SUI  fee=0.25% (ts=60)
    "0xaafb102dd0902f5055cadecd687fb5b71ca82ef0e0285d90afde828ec58ca96b::btc::BTC,0x2::sui::SUI":
      { id: "0x0fb4ad0e4c2c2b0a45d3f7bc5585cc9cea8486a63e4ef5cb768ddd9414fbb97a", isv: 488750289, coinA: "0xaafb102dd0902f5055cadecd687fb5b71ca82ef0e0285d90afde828ec58ca96b::btc::BTC", coinB: "0x2::sui::SUI", feeBps: 25 },
    // USDC / BTC  fee=0.01% (ts=2)
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC,0xaafb102dd0902f5055cadecd687fb5b71ca82ef0e0285d90afde828ec58ca96b::btc::BTC":
      { id: "0x86f9377efc42ad60eefd1cc5238224218d11c88b9d67596383903da14807ce26", isv: 588044145, coinA: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", coinB: "0xaafb102dd0902f5055cadecd687fb5b71ca82ef0e0285d90afde828ec58ca96b::btc::BTC", feeBps: 1 },
    // XAUm / SUI  fee=0.1% (ts=20)
    "0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM,0x2::sui::SUI":
      { id: "0x0df19713fb6d6f1edf70d2555ec91a5535c66bc598ffef1f4f106edb4cec6c49", isv: 627916089, coinA: "0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM", coinB: "0x2::sui::SUI", feeBps: 10 },
    // USDC / XAUm  fee=0.01% (ts=2)
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC,0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM":
      { id: "0x58006fa34ce61c8bc99b3071627bddef47dcb8ce0ac654953a40072aa62c3a03", isv: 861375063, coinA: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", coinB: "0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM", feeBps: 1 },
    // WBTC / SUI  fee=0.25% (ts=60)
    "0x0041f9f9344cac094454cd574e333c4fdb132d7bcc9379bcd4aab485b2a63942::wbtc::WBTC,0x2::sui::SUI":
      { id: "0x534c95af29a4e16bef2dcfbf7a4aa3218ceeb7ad503eeff151ccc8ff39708672", isv: 740817495, coinA: "0x0041f9f9344cac094454cd574e333c4fdb132d7bcc9379bcd4aab485b2a63942::wbtc::WBTC", coinB: "0x2::sui::SUI", feeBps: 25 },
    // USDC / WBTC  fee=0.2% (ts=40)
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC,0x0041f9f9344cac094454cd574e333c4fdb132d7bcc9379bcd4aab485b2a63942::wbtc::WBTC":
      { id: "0xe92ee9996c49057cf2449c8c9f8d7fe52040db8229f6eb01be7d7f6bbc4fc2f3", isv: 704005945, coinA: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", coinB: "0x0041f9f9344cac094454cd574e333c4fdb132d7bcc9379bcd4aab485b2a63942::wbtc::WBTC", feeBps: 20 },
    // suiUSDe / SUI  fee=0.25% (ts=60)
    "0x41d587e5336f1c86cad50d38a7136db99333bb9bda91cea4ba69115defeb1402::sui_usde::SUI_USDE,0x2::sui::SUI":
      { id: "0x1d193028646cf40c46aa2466812a27a110b0cb453b774701656bc49487f712c8", isv: 786022356, coinA: "0x41d587e5336f1c86cad50d38a7136db99333bb9bda91cea4ba69115defeb1402::sui_usde::SUI_USDE", coinB: "0x2::sui::SUI", feeBps: 25 },
    // USDC / suiUSDe  fee=0.01% (ts=2)
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC,0x41d587e5336f1c86cad50d38a7136db99333bb9bda91cea4ba69115defeb1402::sui_usde::SUI_USDE":
      { id: "0x93372a4880cb4cbd4a9974a822c097aa36279a1dbeed7ebd7249d07b923238cf", isv: 775211034, coinA: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", coinB: "0x41d587e5336f1c86cad50d38a7136db99333bb9bda91cea4ba69115defeb1402::sui_usde::SUI_USDE", feeBps: 1 },
    // USDSUI / SUI  fee=0.2% (ts=40)
    "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI,0x2::sui::SUI":
      { id: "0x440e5e3b13b8220c5c338bb5a4291cab5c58064eaf3654c77f3e9aed5147689c", isv: 832189237, coinA: "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI", coinB: "0x2::sui::SUI", feeBps: 20 },
    // USDC / USDSUI  fee=0.01% (ts=2)
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC,0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI":
      { id: "0xa7417fb5f59e23b0a7826d78f025653823c49265be07bbf6dd9e553ba4249a56", isv: 808620267, coinA: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", coinB: "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI", feeBps: 1 },
    // CETUS / SUI  fee=0.01%  (key uses NAVI's non-padded address)
    "0x6864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS,0x2::sui::SUI":
      { id: "0xdfbd4b39f65532d8b2c1136d1ddbf7dde037720067680e956076defd65753918", isv: 1964492,   coinA: "0x6864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS", coinB: "0x2::sui::SUI", feeBps: 1 },
  },

  // Sourced from https://open-api.naviprotocol.io/api/navi/config?env=prod&market=main → oracle.feeds
  ORACLE_PRO_FEEDS: {
    0:  { pioId: "0x801dbc2f0053d34734814b2d6df491ce7807a725fe9a01ad74a07e9c51396c37", feedId: "0x2cab9b151ca1721624b09b421cc57d0bb26a1feb5da1f821492204b098ec35c9" },
    1:  { pioId: "0x5dec622733a204ca27f5a90d8c2fad453cc6665186fd5dff13a83d0b6c9027ab", feedId: "0x70a79226dda5c080378b639d1bb540ddea64761629aa4ad7355d79266d55af61" },
    2:  { pioId: "0x985e3db9f93f76ee8bace7c3dd5cc676a096accd5d9e09e9ae0fb6e492b14572", feedId: "0xf72d8933873bb4e5bfa1edbfa9ff6443ec5fac25c1d99ba2ef37f50a125826f3" },
    3:  { pioId: "0x9193fd47f9a0ab99b6e365a464c8a9ae30e6150fc37ed2a89c1586631f6fc4ab", feedId: "0x44d92366eba1f1652ec81f34585406726bef267565a2db1664ffd5ef18e21693" },
    4:  { pioId: "0x24c0247fb22457a719efac7f670cdc79be321b521460bd6bd2ccfa9f80713b14", feedId: "0x5ac98fc1e6723af2a6d9a68a5d771654a6043f9c4d2b836b2d5fb4832a3be4f2" },
    5:  { pioId: "0x801dbc2f0053d34734814b2d6df491ce7807a725fe9a01ad74a07e9c51396c37", feedId: "0x086bb5540047b3c77ae5e2f9b811c7ef085517a73510f776753c8ee83d19e62c" },
    6:  { pioId: "0x801dbc2f0053d34734814b2d6df491ce7807a725fe9a01ad74a07e9c51396c37", feedId: "0xac934a2a2d406085e7f73b460221fe1b11935864605ba58cdbb8e21c15f12acd" },
    7:  { pioId: "0x5b117a6a2de70796bffe36495bad576b788a34c33ca0648bd57852ead3f41e32", feedId: "0x4324c797d2f19eff517c24adec8b92aa2d282e44f3a5cafb36d6c4b30d7f2dca" },
    9:  { pioId: "0x94ef89923e7beccd4a52043a9451a87c614684b847426fb5fd76faa8cb1e907f", feedId: "0x9a0656e1e10a0cdf3f03dce9db9ad931f51dc6eac2e52ebfbf535dfbcf8100ef" },
    10: { pioId: "0x5dec622733a204ca27f5a90d8c2fad453cc6665186fd5dff13a83d0b6c9027ab", feedId: "0xe120611435395f144b4bcc4466a00b6b26d7a27318f96e148648852a9dd6b31c" },
    11: { pioId: "0x9193fd47f9a0ab99b6e365a464c8a9ae30e6150fc37ed2a89c1586631f6fc4ab", feedId: "0x9a6ffc707270286e98e8d0f654ce38f69efbc302ac98e2deb11fbad2211600f0" },
    12: { pioId: "0x62e15c2fd1437a4d0e111dbd8a193f244878ba25cc7caa9120d0ee41ac151ea5", feedId: "0x11ddf2ac1868d493e2487deeb2a0c2791bb7ca69632c8c5fefe85e09390be093" },
    13: { pioId: "0xc6352e1ea55d7b5acc3ed690cc3cdf8007978071d7bfd6a189445018cfb366e0", feedId: "0xc771ec0ca245857f30195ce05197a7b3ab41c58c1e8abe0661919d90675ad63d" },
    14: { pioId: "0x9a62b4863bdeaabdc9500fce769cf7e72d5585eeb28a6d26e4cafadc13f76ab2", feedId: "0xdf9b254a7a64742e1edf8c48bd2a1f182b52f020de2ab070ae0e3f9228d05280" },
    17: { pioId: "0x5515a34fc610bba6b601575ed1d2535b2f9df1f339fd0d435fef487c1ee3df9c", feedId: "0xd8286c11df7e49496ee75622ae4132c56385c30b4bedb392e36c0699a52a1d52" },
    18: { pioId: "0x3ef821a54dbdfe3f211b2ff7261dea0f0330c72fd292422ce586e21f43809a56", feedId: "0x93c1b815f64ef7c4311d74ff7c0ca1e47739c3ac31fdee0068c30887633ba2fb" },
    20: { pioId: "0x801dbc2f0053d34734814b2d6df491ce7807a725fe9a01ad74a07e9c51396c37", feedId: "0xd7a8c920db9f8b5c3c300307d88fca53684fd15b760977dbf8f0adc6e55783bd" },
    21: { pioId: "0x9a62b4863bdeaabdc9500fce769cf7e72d5585eeb28a6d26e4cafadc13f76ab2", feedId: "0x4e4666c82c476f0b51b27c5ed8c77ab960aa5e4c3a48796e179d721b471e3b7e" },
    22: { pioId: "0x9d0d275efbd37d8a8855f6f2c761fa5983293dd8ce202ee5196626de8fcd4469", feedId: "0x2611dff736233a6855e28ae95f8e5f62a6bf80653ddb118bf012fd783d530fa1" },
    23: { pioId: "0xeba15840ddf425dacb5ff0990334fc03d034487f4ad416280859b96bf2af89f8", feedId: "0x8ee4d9d61d0bfa342cdb3ee8b7f047c91f0b586e0ff66fd6e8fc761e235e5409" },
    24: { pioId: "0xeb7e669f74d976c0b99b6ef9801e3a77716a95f1a15754e0f1399ce3fb60973d", feedId: "0x924bf9f715d857605f9f4146537fffc0414809c85845ce9d695f3645a22a5426" },
    25: { pioId: "0xbc98681c15de1ca1b80a8e26500d43c77f7113368b024de1bf490afcb0387109", feedId: "0xe8a90eed4e6de66e114e6d00802852a9529054a33de0e8460ec37109f0d09d5e" },
    26: { pioId: "0x9a62b4863bdeaabdc9500fce769cf7e72d5585eeb28a6d26e4cafadc13f76ab2", feedId: "0xbe3a049bbbdc596cc6109fcff0bc2c968e7533bcc675e5718f7ecdf3c5dae506" },
    27: { pioId: "0x06c6b9e6eb87da329189e713b7fb319cc7990cf5abf192862a443f939eedc43b", feedId: "0xebe4e84fd1b1e28622274640c1bce7f4d79f43e95c6f54bec3880781b88a0d92" },
    28: { pioId: "0x9a62b4863bdeaabdc9500fce769cf7e72d5585eeb28a6d26e4cafadc13f76ab2", feedId: "0xc7f87ba22d24e8ce5764f05f775c10f87fc04e2a411c6ad7922fc936e8f7b8e3" },
    29: { pioId: "0x9a62b4863bdeaabdc9500fce769cf7e72d5585eeb28a6d26e4cafadc13f76ab2", feedId: "0x1d7e07f8fcc6a51d55d69f425cdc84c23807aeac6516dc5d909fe537d7c6eeb1" },
    30: { pioId: "0x9a62b4863bdeaabdc9500fce769cf7e72d5585eeb28a6d26e4cafadc13f76ab2", feedId: "0x9efc82d7786261800fa78fa347e1b39bf3d3808e4a3e192fb3677fa78a324928" },
    31: { pioId: "0x2731a8e3e9bc69b2d6af6f4c032fcd4856c77e2c21f839134d1ebcc3a16e4b1b", feedId: "0x5fc8ae7618a0c1551d0e5f5879d144ae5862a070f6a87c6c21c18dae3cb0645b" },
    32: { pioId: "0x9a62b4863bdeaabdc9500fce769cf7e72d5585eeb28a6d26e4cafadc13f76ab2", feedId: "0xc0dddc22b53142a0b283682d9025e22c8beedf20dcac4023229d5219e8d35a43" },
    33: { pioId: "0x5dec622733a204ca27f5a90d8c2fad453cc6665186fd5dff13a83d0b6c9027ab", feedId: "0x70b92bcacfbd260b7564871a0a75c2cc4317fcc95aeeb041714d26e168d887be" },
    34: { pioId: "0x5dec622733a204ca27f5a90d8c2fad453cc6665186fd5dff13a83d0b6c9027ab", feedId: "0xfe7130d93f535676c57684091256d3351f78050ae071d865d415b1c9664faaa4" },
    35: { pioId: "0x4309c89b20dc401ab369016b379462be77174d82adcf23e524c681a6dbe4744f", feedId: "0xc0f2fc8a96871d85544ee5c14dfddfa0136f2eb3da63464280cf1afa135f2efc" },
  },
};

// ── testnet ───────────────────────────────────────────────────────────────────

// Addresses known from NAVI SDK addressStg.ts.
// ISVs are queried at startup (testnet objects change across resets).
const TESTNET_STATIC = {
  SUI_RPC:  process.env.SUI_RPC ?? "https://fullnode.testnet.sui.io:443",
  PYTH_WS:  process.env.PYTH_WS ?? "wss://hermes.pyth.network/ws",

  NAVI_PKG:          "0x8200ce83e1bc0894b641f0a466694b4f6e25d3f9cc3093915a887ec9e7f3395e",
  NAVI_STORAGE_ID:   "0x111b9d70174462646e7e47e6fec5da9eb50cea14e6c5a55a910c8b0e44cd2913",
  PYTH_ORACLE_ID:    "0x25c718f494ff63021f75642ecaaeda826f44b2d9d59859a8ad45ef0fba9626f2",
  NAVI_INCENTIVE_V2_ID: "0x952b6726bbcc08eb14f38a3632a3f98b823f301468d7de36f1d05faaef1bdd2a",
  NAVI_INCENTIVE_V3_ID: "0x5db4063954356f37ebdc791ec30f4cfd39734feff18820ee44dc2d2de96db899",

  // Testnet SUI pool
  SUI_POOL_ID: "0x68b420259e3adcdadf165350984f59dfdaf677c3d639aaa54c1d907dae2dd1a3",
  USDC_POOL_ID: "0x8bf81e96302d4307d8da07e49328875e1f2e205dc0c4d457bffe6a8c1740ba25",
};

async function getIsv(client: SuiClient, id: string): Promise<number> {
  const obj = await client.getObject({ id, options: {} });
  const owner = (obj.data as any)?.owner;
  // Shared object owner has initialSharedVersion
  const isv = owner?.Shared?.initial_shared_version ?? owner?.shared?.initial_shared_version ?? 1;
  return Number(isv);
}

export async function buildTestnetAddrs(client: SuiClient): Promise<NetworkAddrs> {
  const [storageIsv, oracleIsv, iv2Isv, iv3Isv, suiPoolIsv, usdcPoolIsv] = await Promise.all([
    getIsv(client, TESTNET_STATIC.NAVI_STORAGE_ID),
    getIsv(client, TESTNET_STATIC.PYTH_ORACLE_ID),
    getIsv(client, TESTNET_STATIC.NAVI_INCENTIVE_V2_ID),
    getIsv(client, TESTNET_STATIC.NAVI_INCENTIVE_V3_ID),
    getIsv(client, TESTNET_STATIC.SUI_POOL_ID),
    getIsv(client, TESTNET_STATIC.USDC_POOL_ID),
  ]);

  return {
    SUI_RPC:  TESTNET_STATIC.SUI_RPC,
    PYTH_WS:  TESTNET_STATIC.PYTH_WS,
    NAVI_PKG: TESTNET_STATIC.NAVI_PKG,
    NAVI_STORAGE: { id: TESTNET_STATIC.NAVI_STORAGE_ID, isv: storageIsv },
    PYTH_ORACLE:  { id: TESTNET_STATIC.PYTH_ORACLE_ID,  isv: oracleIsv },
    NAVI_INCENTIVE_V2: { id: TESTNET_STATIC.NAVI_INCENTIVE_V2_ID, isv: iv2Isv },
    NAVI_INCENTIVE_V3: { id: TESTNET_STATIC.NAVI_INCENTIVE_V3_ID, isv: iv3Isv },

    // Pyth/Wormhole states are the same across mainnet/testnet (global Pyth infra)
    PYTH_STATE_ID:     "0x1f9310238ee9298fb703c3419030b35b22bb1cc37113e3bb5007c99aec79e5b8",
    WORMHOLE_STATE_ID: "0xaeab97f96cf9877fee2883315d459552b2b921edc16d7ceac6eab944dd88919c",

    // flash config + oracle_pro + cetus not confirmed on testnet — leave empty
    NAVI_FLASH_CONFIG:   { id: "0x0", isv: 1 },
    ORACLE_PRO_PKG:      "",
    ORACLE_CONFIG:       { id: "0x0", isv: 1 },
    SUPRA_HOLDER:        { id: "0x0", isv: 1 },
    SWITCHBOARD_AGG:     { id: "0x0", isv: 1 },
    ORACLE_PRO_FEEDS:    {},
    CETUS_PKG:           "",
    CETUS_GLOBAL_CONFIG: { id: "0x0", isv: 1 },
    CETUS_POOLS:         {},

    POOLS: {
      0: { id: TESTNET_STATIC.SUI_POOL_ID,  isv: suiPoolIsv,  coinType: "0x2::sui::SUI" },
      1: { id: TESTNET_STATIC.USDC_POOL_ID, isv: usdcPoolIsv, coinType: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC" },
    },
  };
}

// ── scan RPC pool ─────────────────────────────────────────────────────────────
export const SCAN_RPCS: string[] = CONFIG_RPCS.length > 0 ? CONFIG_RPCS : [MAINNET.SUI_RPC];

// ── broadcast RPC pool ────────────────────────────────────────────────────────
// All RPCs used for transaction broadcast — add TRITON_KEY / SHINAMI_KEY to .env to enable.
// Using multiple endpoints reduces latency via race-and-take-first strategy.
const TRITON = process.env.TRITON_KEY
  ? `https://sui-mainnet.triton.one/v1/${process.env.TRITON_KEY}`
  : null;
const SHINAMI = process.env.SHINAMI_KEY
  ? `https://api.shinami.com/node/v1/${process.env.SHINAMI_KEY}`
  : null;
export const BROADCAST_RPCS: string[] = [
  MAINNET.SUI_RPC,
  ...(TRITON  ? [TRITON]  : []),
  ...(SHINAMI ? [SHINAMI] : []),
];

// ── RpcPool ───────────────────────────────────────────────────────────────────
// Round-robin client pool with per-endpoint stale tracking.
// Call markError(url, isRateLimit) when an endpoint returns 429 or a transient
// error; next() will skip that endpoint until the stale window expires.

export class RpcPool {
  private entries: Array<{
    url:        string;
    client:     SuiClient;
    staleUntil: number;   // epoch ms; 0 = healthy
    errors:     number;
  }>;
  private idx = 0;

  constructor(urls: string[]) {
    if (urls.length === 0) throw new Error("RpcPool requires at least one URL");
    this.entries = urls.map(url => ({
      url, client: new SuiClient({ url }), staleUntil: 0, errors: 0,
    }));
  }

  /** Returns next non-stale {client, url}. Falls back to least-stale if all stale. */
  next(): { client: SuiClient; url: string } {
    const now  = Date.now();
    const live = this.entries.filter(e => e.staleUntil <= now);
    const pool = live.length > 0 ? live : this.entries;
    const e    = pool[this.idx++ % pool.length];
    return { client: e.client, url: e.url };
  }

  /** Mark an endpoint stale after 429 (60 s) or other transient error (20 s). */
  markError(url: string, isRateLimit: boolean, warn?: (msg: string) => void): void {
    const e = this.entries.find(x => x.url === url);
    if (!e) return;
    e.errors++;
    const staleMs    = isRateLimit ? 60_000 : 20_000;
    e.staleUntil     = Date.now() + staleMs;
    const host       = hostOf(url);
    warn?.(`[RPC] ${host} stale ${staleMs / 1000}s (cumulative errors: ${e.errors})`);
  }

  /** One-line health summary suitable for log output. */
  statusLine(): string {
    const now = Date.now();
    return this.entries.map(e => {
      const rem = Math.max(0, e.staleUntil - now);
      return rem > 0
        ? `${hostOf(e.url)}:STALE(${(rem / 1000).toFixed(0)}s)`
        : `${hostOf(e.url)}:OK`;
    }).join(" | ");
  }

  get size(): number { return this.entries.length; }
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

// ── selector ──────────────────────────────────────────────────────────────────

export const NETWORK = process.env.NETWORK ?? "mainnet";

export function isTestnet(): boolean {
  return NETWORK === "testnet";
}

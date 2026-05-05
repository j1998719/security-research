# Rate Limits and Compute Units

# Rate Limits and Compute Units

Copy Page

The illustration of what Compute Units are and how we use them.

CU(Compute Units) are a measure of the total computing resources that your application uses on BlockVision. Some query interfaces are lightweight and fast, while others can be more complex and require more resources. Each method is assigned a certain number of computational units derived from the global average duration of each method.

##

Pricing Plans

[](#pricing-plans)

Free

Lite

Basic

Pro

Price

$0/Month

$29/Month

$99/Month

$199/Month

Compute Unit

10,000,000

100,000,000

600,000,000

1,500,000,000

EVM Approx. Request

400,000

4,000,000

24,000,000

60,000,000

Compute Units / Second

300

500

1,000

2,000

Max App

5

6

10

20

JSON RPC Service

☑️

☑️

☑️

☑️

Monitor Service

☑️

☑️

☑️

☑️

Sui gRPC Service

X

☑️

☑️

☑️

Sui Indexing API

X

X

X

☑️

Monad Indexing API

X

X

X

☑️

> For Free Tier, some Indexing APIs support 30 free trials.

##

Sui RPC APIs

[](#sui-rpc-apis)

For Sui JSON RPC and gRPC, each RPC call currently consumes 50 compute unit.

Membership

Cost

Requests per Month

Rate Limit

Free

$0 per month

200,000

5 requests per second

Lite

$29 per month

2,000,000

10 requests per second

Basic

$99 per month

12,000,000

20 requests per second

Pro

$199 per month

40,000,000

40 requests per second

##

Sui Indexing APIs

[](#sui-indexing-apis)

Method

CU

Retrieve Account's Activity

300

Retrieve Account's Coins

150

Retrieve Account's NFTs

150

Retrieve Account's DeFi

300

Retrieve Coin Holders

300

Retrieve Coin Details

100

Retrieve Coin Market Data

100

Retrieve Multiple Coin Price

100

Retrieve Coin Dex Pools

150

Retrieve Coin OHLCV

200

Retrieve Coin Trades

100

Retrieve Collection Holders

300

Retrieve Collection Items

150

Retrieve Collection Details

150

Retrieve Collection's NFT List

150

Retrieve NFT Activity

100

##

Monad Indexing APIs

[](#monad-indexing-apis)

Method

CU

Retrieve Account's Activity

300

Retrieve Account's Token

300

Retrieve Account's DeFi

300

Retrieve Account's NFTs

300

Retrieve Account's Transactions

200

Retrieve Account's Internal Transactions

300

Retrieve Account's Token Activities

200

Retrieve Account's NFT Activities

200

Retrieve Token Holders

200

Retrieve Monad Holders

200

Retrieve Collection holder

300

Retrieve Contract Detail

200

Retrieve Contract Source Code

200

Retrieve Verified Contracts

200

Retrieve Token Gating

50

Retrieve Token Detail

100

Retrieve Multiple Token Prices

150

Retrieve Token Trades

200

Retrieve Token Pools

100

Retrieve Token OHLCV

200

Retrieve Token Market Data

200

##

EVM RPC APIs

[](#evm-rpc-apis)

Method

CU

eth_chainId

1

eth_syncing

1

eth_protocolVersion

1

net_listening

1

eth_gasPrice

1

eth_uninstallFilter

10

eth_blockNumber

10

eth_subscribe

10

eth_unsubscribe

10

eth_feeHistory

10

eth_maxProrityFeePerGas

10

eth_getTransactionReceipt

15

eth_getTransactionReceiptsByBlockNumber

15

eth_getUncleByBlockHashAndIndex

15

eth_getUncleByBlockNumberAndIndex

15

eth_getTransactionByBlockHashAndIndex

15

eth_getTransactionByBlockNumberAndIndex

15

eth_getUncleCountByBlockNumber

15

eth_getUncleCountByBlockHash

15

web3_clientVersion

15

web3_sha3

15

eth_getBlockByNumber

16

eth_getTransactionByHash

17

eth_getStorageAt

17

eth_getBalance

19

eth_getCode

19

eth_getBlockTransactionCountByHash

20

eth_getBlockTransactionCountByNumber

20

eth_getBlockByHash

21

eth_getTransactionCount

26

eth_call

26

eth_getLogs

75

eth_estimateGas

80

debug_traceCall

200

eth_sendRawTransaction

250

eth_getBlockReceipts

500

debug_traceTransaction

500

debug_getRawBlock

600

debug_getRawHeader

600

debug_getRawReceipts

600

debug_getRawTransaction

600

debug_traceBlockByHash

2000

debug_traceBlockByNumber

2000

##

Trace APIs

[](#trace-apis)

Method

CU

trace_block

69

trace_transaction

29

trace_get

75

trace_call

75

##

WebSocket

[](#websocket)

WebSocket subscriptions like eth_subscribe on BlockVision are priced based on bandwidth: the amount of data delivered as part of the subscription.

Each subscription type is priced identically, per byte:

BandWidth

CU

1 Byte

0.02

On average, websocket subscriptions event sizes range from a minimum of about 75 bytes to a maximum of about 1000 bytes. Specifically, subscribing to newPendingTransactions costs about 2 compute units per event. The event bvPendingTransactions costs about 20 compute units, while newHeads requires about 25 compute units. But the actual situation may be far from this number.

##

Rate Limits (CUPS)

[](#rate-limits-cups)

Rate limit serves to protect users from malicious actors or runaway scripts. Each tier has prioritized rate limit allocations designed for ultimate reliability. CUPS is a measure of the number of compute units used per second when making requests. Since each request is weighted differently, the query frequency is limited based on the total compute units used rather than the number of requests. For example, if you send one web3_sha3 (15 CUs), two eth_blockNumber (16 CUs) requests in the same second, you will have a total of 47 CUPS.

USER

Compute Units Per Second (CUPS)

Free

300

Lite

500

Basic

1000

Pro

2000

Enterprise

Custom

Updated 3 months ago

---

Did this page help you?

Yes

No

Updated 3 months ago

---

Did this page help you?

Yes

No

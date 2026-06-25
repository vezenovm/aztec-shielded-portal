# aztec-shielded-portal — Tornado → Aztec bridge PoC

A proof-of-concept bridge that lets a user withdraw ETH from a Tornado Cash pool into an
Ethereum L1 bridge contract, then mint a private Aztec note representing **`tornadoETH`** —
a reserve-backed claim on the ETH locked in the bridge.

> **This is a PoC. It is not production-ready.**
>
> - It does **not** implement Tornado zk proofs. Tornado is modeled as an existing
>   external shielded pool via `MockTornadoPool`.
> - The bridge mints private `tornadoETH` on Aztec, 1:1 backed by ETH locked on L1.
> - **Tornado-origin provenance is public** — by design, every wei of reserve is
>   attributable to a Tornado pool withdrawal.
> - **Aztec ownership and transfers are private** — note ownership, balances and
>   transfers of `tornadoETH` are hidden.

## Flow

```text
Tornado note
  -> withdrawToBridge (MockTornadoPool)            L1, public
  -> onTornadoWithdrawal (TornadoEthBridgeL1)      L1 locks ETH, registers depositId
  -> Inbox.sendL2Message                           L1 -> L2 message (commitment in secretHash slot)
  -> claim_from_tornado_bridge (TornadoEthToken)   Aztec, private mint to hidden recipient
  -> transfer_private                              Aztec, private
  -> burn_for_l1_withdrawal                        Aztec, private burn + L2 -> L1 message
  -> withdrawFromAztec (TornadoEthBridgeL1)        L1 consumes outbox leaf, releases ETH
```

## Privacy model

| Public (L1 / by design)                          | Private (Aztec)                       |
| ------------------------------------------------ | ------------------------------------- |
| A Tornado withdrawal occurred, into the bridge   | The recipient of minted `tornadoETH`  |
| The denomination (1 ETH) and total reserves      | Ownership of `tornadoETH` notes       |
| L1 redemption recipient + amount                 | Transfers and intermediate balances   |
| Timing correlation between L1 entry and L2 mint  | The identity of the burner            |

### Mint commitment (how L1 never learns the Aztec recipient)

The user generates a random `mint_secret` and passes a single `bytes32` through the
Tornado withdrawal calldata:

```text
inner               = poseidon2([aztec_recipient, mint_secret, amount])
aztecMintCommitment = compute_secret_hash(inner)          # poseidon2 + secret-hash domain
```

The bridge forwards the commitment as the L1→L2 message's `secretHash`; the message
content commits to `(depositId, amount)`. On Aztec, `claim_from_tornado_bridge`
recomputes `inner` from the **caller's** address — consumption only succeeds for the
recipient committed to at deposit time, and the message nullifier makes the claim
single-use. Wrong secret, wrong amount, wrong recipient, or a second claim all fail
(covered in `test/aztec.test.ts`).

### Withdrawal (burn → redeem)

`burn_for_l1_withdrawal(recipient_l1, amount, nonce)` nullifies the caller's notes
(change is re-issued automatically) and emits an L2→L1 message committing to
`(bridge, recipient_l1, amount, nonce)` — the burner's identity is not in the message.
Once the epoch settles into the L1 Outbox, **anyone** may execute
`withdrawFromAztec(...)` with the merkle witness (the executor only pays gas; funds can
only go to the committed recipient). Consuming the outbox leaf is the replay protection:
one burn = exactly one redemption. The bridge has **no `receive()`** — the pool callback
is the only ETH ingress, which is what makes provenance attributable.

## Repo layout

```text
contracts/
  l1/                      Foundry project
    src/MockTornadoPool.sol         mock fixed-denomination pool (no zk proofs)
    src/TornadoEthBridgeL1.sol      portal: ingress, reserves, egress
    src/IAztecMinimal.sol           minimal ABI slices of IRegistry/IRollup
    test/*.t.sol                    spec L1 tests 1-10 + hardening (mocked Inbox/Outbox)
  aztec/tornado_eth_token/  Aztec contract (Noir)
    src/main.nr                     claim / transfer_private / burn / balance_of utility
    src/content_hashes.nr           sha256 content hashes, byte-identical to L1
    src/test/                       TXE unit tests
src/                       TS library (commitment + hash mirrors + deploy/flow helpers)
  generated/                        `aztec codegen` output (rebuilt, not committed)
test/
  aztec.test.ts            spec "Aztec tests" 1-9 (needs local network)
  e2e.test.ts              spec end-to-end steps 1-8 incl. L1 redemption
scripts/                   deploy-l1 / deploy-aztec / demo-flow
```

## Toolchain & version pinning

Everything pins to one nightly — **`5.0.0-rc.1`** — across the sandbox CLI,
`@aztec/*` npm packages, and the `aztec-nr` git tag in `Nargo.toml`. The L1 contracts
import Aztec core interfaces (`IInbox`, `IOutbox`, `Hash`, `DataStructures`) and
forge-std straight out of the **`@aztec/l1-artifacts` npm package** (see
`contracts/l1/foundry.toml` remappings), so the Solidity side is version-locked too.

Prerequisites: Node 22+, Yarn 4 (corepack), Foundry, and

```bash
aztec-up install 5.0.0-rc.1
aztec --version   # must print 5.0.0-rc.1
```

## Quickstart

```bash
corepack enable && yarn install
yarn build                  # noir compile + codegen + forge build + tsc

# fast, no network needed:
yarn test:l1                # 24 Foundry tests (spec L1 tests 1-10 + hardening)
yarn test:sdk               # SDK config/unit coverage
yarn test:aztec-unit        # TXE suite

# in a separate terminal:
aztec start --local-network # anvil :8545 + aztec node :8080

yarn test:aztec             # spec Aztec tests 1-9 (claims, transfers, burns)
yarn test:e2e               # full 8-step flow incl. L1 redemption
yarn demo                   # narrated end-to-end demo

# or step by step:
yarn deploy:l1              # pool + bridge -> config.local.json
yarn deploy:aztec           # tornadoETH + bridge.initialize
```

There is no separate `portal` CLI in this PoC. The public lifecycle surface is the TS
SDK plus the runnable `yarn demo` walkthrough; a CLI would mostly duplicate the SDK and
force state/artifact UX decisions that are deferred until the integration surface is
more settled.

Note on L2→L1 redemption locally: the local network does no real proving; its
`EpochTestSettler` pushes each completed epoch's out-hash into the L1 Outbox (epoch =
2 checkpoints), which is what makes `withdrawFromAztec` consumable without a prover.

## Environment

Local defaults target `aztec start --local-network`: Anvil on `http://localhost:8545`
with chain id `31337`, and the local Aztec node on `http://localhost:8080`.

| Variable | Purpose |
| -------- | ------- |
| `L1_RPC_URL` | L1 RPC URL; comma-separated URLs are accepted. |
| `L1_CHAIN_ID` | L1 chain id used for viem transactions and L2→L1 burn-message hashing. |
| `L1_PRIVATE_KEY` | L1 signer private key; preferred over `L1_MNEMONIC`. |
| `L1_MNEMONIC` | L1 signer mnemonic. |
| `AZTEC_NODE_URL` | Aztec node/PXE endpoint. |

If the L1 RPC/chain is not local Anvil, set `L1_PRIVATE_KEY` or `L1_MNEMONIC`; the
well-known Anvil test mnemonic is only used for local chain id `31337` on localhost.

## SDK lifecycle

`scripts/demo-flow.ts` is the canonical runnable example. It deploys a fresh stack,
then executes the full withdraw→claim→transfer→burn→redeem path with balance output.
`test/e2e.test.ts` covers the same path with assertions and replay checks.

```ts
import {
  ONE_ETH,
  balanceOfPrivate,
  burnForL1Withdrawal,
  claimTornadoEth,
  getBurnWitness,
  getTotalLockedEth,
  makeMessageConsumable,
  setupBridgeStack,
  withdrawFromAztecOnL1,
  withdrawFromTornadoToBridge,
} from './src/index.js';

const stack = await setupBridgeStack();
const [alice, bob] = stack.accounts;

const deposit = await withdrawFromTornadoToBridge(stack, alice);
await makeMessageConsumable(stack, deposit, alice);
await claimTornadoEth(stack.token, alice, deposit);

await stack.token.methods.transfer_private(bob, (4n * ONE_ETH) / 10n).send({ from: alice });

const l1Recipient = '0x3000000000000000000000000000000000000003' as const;
const burn = await burnForL1Withdrawal(stack, bob, l1Recipient, (25n * ONE_ETH) / 100n);
const witness = await getBurnWitness(stack, burn, alice);
await withdrawFromAztecOnL1(stack, burn, witness);

console.log(await balanceOfPrivate(stack.token, alice));
console.log(await getTotalLockedEth(stack.l1Client, stack.bridge));
```

For direct integration, construct an L1 client with `makeL1Client({ rpcUrl, chainId,
privateKey })`, connect to Aztec with `connectToAztec(AZTEC_NODE_URL)`, deploy or load a
`TornadoEthTokenContract`, and pass the resulting client/token objects into the same
helpers. Commitment helpers (`generateMintSecret`, `computeAztecMintCommitment`) are
also exported for callers that need to split commitment generation from the L1 pool
withdrawal.

## Deviations from the spec

Protocol reality required a few interface adjustments; the substance is unchanged:

1. `claim_from_tornado_bridge` gains a `message_leaf_index: Field` parameter — consuming
   an L1→L2 message requires its inbox leaf index (returned by `sendL2Message`, surfaced
   in the `TornadoBridgeDeposit` event).
2. `withdrawFromAztec` takes the real outbox witness `(nonce, epoch,
   numCheckpointsInEpoch, leafIndex, path)` instead of a bare `burnMessageHash`; the
   message (and its hash, emitted in `AztecRedemption`) is reconstructed in-contract.
3. `depositId` uses `Hash.sha256ToField` rather than raw `keccak256` so the id fits in a
   Noir field and can be recomputed identically inside the claim circuit.
4. `aztecMintCommitment = compute_secret_hash(poseidon2([recipient, mint_secret,
   amount]))` rides in the message's `secretHash` slot (the protocol's native private-
   consumption mechanism); the content carries `(depositId, amount)`. The message leaf
   commits to all of it.
5. The spec's L1 unit tests live in Foundry (`contracts/l1/test`), not `l1.test.ts`.
   Aztec claim-path cases live in `test/aztec.test.ts` against the local network — the
   TXE cannot inject L1→L2 messages at this version.
6. `TornadoBridgeDeposit` additionally emits `(messageKey, messageLeafIndex)` so clients
   don't need to recompute them.

## Adding another bridge (e.g. privacyPoolsETH)

Per-origin assets stay isolated so provenance is obvious. The recipe:

1. **L1**: new portal contract with its own ingress (e.g. verify a Privacy Pools
   withdrawal instead of `onTornadoWithdrawal`). The generic seams to lift from
   `TornadoEthBridgeL1` are `_registerDeposit`, `_sendMintMessage`, and
   `withdrawFromAztec` — they contain nothing Tornado-specific.
2. **L2**: deploy a second instance of the same token contract shape paired with the new
   portal (`TornadoEthToken` is origin-agnostic apart from naming) — that instance *is*
   `privacyPoolsETH`.
3. Extract a shared abstract base / generic token only when the second bridge actually
   exists; the PoC deliberately ships concrete contracts.

Do **not** merge origins into one asset; a future unified `shieldedETH` would be a
separate design with hidden origin metadata.

## Security notes (as implemented)

- ETH leaves L1 only by consuming a valid L2→L1 burn message (`Outbox.consume` reverts
  on invalid or replayed leaves) — `test_ValidBurnMessageReleasesEth`,
  `test_RevertWhen_BurnMessageReplayed`.
- `tornadoETH` mints only by consuming a valid L1→L2 deposit message (message nullifier
  prevents re-claims) — `rejects claiming the same deposit twice`.
- One deposit = one claim (`consumedDepositIds` + message nullifier); one burn = one
  redemption (outbox leaf consumption).
- The Aztec recipient never appears on L1 (commitment scheme above).
- Checks-effects-interactions + a reentrancy guard on `withdrawFromAztec`
  (`test_ReentrantWithdrawalIsBlocked`), and reserves can never go negative
  (`test_RevertWhen_WithdrawExceedsLockedReserve`).
- No plain ETH ingress (`test_BridgeHasNoPlainEthIngress`).

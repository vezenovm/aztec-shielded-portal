# aztec-shielded-portal

Tornado Cash → Aztec bridge PoC. ETH withdrawn from a Tornado pool is locked in an L1 portal and
minted on Aztec as private **`tornadoETH`**, 1:1 reserve-backed and redeemable back to L1.

> **Unaudited research PoC.** Tornado provenance is public by design; Aztec ownership, balances and
> transfers are private. See [SECURITY.md](./SECURITY.md).

## Flow

```text
Tornado withdrawal -> TornadoEthBridgeL1 (lock ETH)  -> Inbox.sendL2Message      L1, public
                   -> claim_from_tornado_bridge      (private mint)              Aztec
                   -> transfer_private                                           Aztec
                   -> burn_for_l1_withdrawal         (private burn, L2->L1 msg)  Aztec
                   -> withdrawFromAztec              (consume outbox, release)   L1
```

**Deposit → mint.** The user picks a random `mint_secret` and passes one `bytes32` through the
Tornado withdrawal:

```text
aztecMintCommitment = compute_secret_hash([poseidon2([aztec_recipient, mint_secret, amount])])
```

It rides in the L1→L2 message's `secretHash` slot; the content commits to `(depositId, amount)`.
`claim_from_tornado_bridge` recomputes the preimage from `msg_sender`, so only the committed
recipient can claim, and the message nullifier makes it single-use. L1 never sees the recipient.

**Burn → redeem.** `burn_for_l1_withdrawal(recipient_l1, amount, nonce)` nullifies the burner's
notes and emits an L2→L1 message over `(bridge, recipient_l1, amount, nonce)`, without the burner's
identity. Once the epoch settles, anyone can call `withdrawFromAztec` with the outbox witness; funds
only go to the committed recipient, and consuming the leaf prevents replay. The bridge has no
`receive()`: pool withdrawals are the only ETH ingress.

| Public (L1)                                  | Private (Aztec)                     |
| -------------------------------------------- | ----------------------------------- |
| A Tornado withdrawal into the bridge         | Recipient of minted `tornadoETH`    |
| Denomination and total reserves              | Note ownership and balances         |
| L1 redemption recipient + amount             | Transfers, identity of the burner   |
| Timing correlation of L1 entry and L2 mint   |                                     |

## Toolchain

```bash
aztec-up install 6.0.0
```

## Quickstart

```bash
corepack enable && yarn install
yarn build                    # noir compile + codegen + aztec-forge build + tsc
yarn test:l1 && yarn test:sdk && yarn test:aztec-unit   # offline

aztec start --local-network   # separate terminal: anvil :8545 + aztec node :8080
yarn test:aztec && yarn test:e2e
yarn demo                     # narrated end-to-end run
```

## CLI

`yarn portal <command>` wraps the SDK and persists state to `portal-state.json` (`$PORTAL_STATE`):

```bash
yarn portal setup [--real]            # deploy + wire the stack (mock pool, or the forwarder path)
yarn portal generate-secret
yarn portal generate-commitment --recipient <addr> --secret <s> [--amount <wei>]
yarn portal withdraw-to-portal [--recipient <idx|addr>]
yarn portal claim [--deposit <idx>] [--recipient <idx|addr>]
yarn portal transfer --to <addr> --amount <wei> [--from <idx|addr>]
yarn portal burn --recipient-l1 <0x> --amount <wei> [--from <idx|addr>] [--redeem]
```

Locally, redemption works without a prover: the local network's `EpochTestSettler` pushes each
completed epoch's out-hash into the L1 Outbox.

## Environment

Defaults target `aztec start --local-network` (Anvil `http://localhost:8545`, chain id `31337`;
Aztec node `http://localhost:8080`).

| Variable | Purpose |
| -------- | ------- |
| `L1_RPC_URL` | L1 RPC URL (comma-separated accepted). |
| `L1_CHAIN_ID` | L1 chain id (viem txs + L2→L1 message hashing). |
| `L1_PRIVATE_KEY` / `L1_MNEMONIC` | L1 signer. Required off local Anvil. |
| `AZTEC_NODE_URL` | Aztec node endpoint. |

## SDK

`scripts/demo-flow.ts` is the canonical example; `test/e2e.test.ts` asserts the same path.

```ts
const stack = await setupBridgeStack();
const [alice, bob] = stack.accounts;

const deposit = await withdrawFromTornadoToBridge(stack, alice);
await makeMessageConsumable(stack, deposit, alice);
await claimTornadoEth(stack.token, alice, deposit);

await stack.token.methods.transfer_private(bob, ONE_ETH / 2n).send({ from: alice });

const burn = await burnForL1Withdrawal(stack, bob, '0x3000000000000000000000000000000000000003', ONE_ETH / 4n);
await withdrawFromAztecOnL1(stack, burn, await getBurnWitness(stack, burn, alice));
```

## Real Tornado (Classic)

Real pools pay via `recipient.call{value}("")`, which can't carry a commitment. So the commitment is
bound into the proof's `recipient`: `recipient = CREATE2(ForwarderFactory, salt = aztecMintCommitment)`.
The per-commitment `Forwarder` deployed there forwards exactly the denomination to the portal, which
re-derives the address and checks it against `msg.sender`. Changing the commitment changes the
recipient, which invalidates the proof. If someone replays the proof directly against the pool, the
ETH lands at the undeployed forwarder; anyone can then call `ForwarderFactory.bridgeSpentWithdrawal`
with the same proof, which re-verifies it against the pool's verifier and finishes the original
mint (the SDK does this automatically). Each Tornado nullifier bridges at most once; see
[SECURITY.md](./SECURITY.md) for the weaker ETH provenance on that recovery path.

Proving is delegated to a caller-supplied `tornado-cli` (`proveViaTornadoCli`); nothing from Tornado
is vendored.

| Tier | What | Runs |
| ---- | ---- | ---- |
| 1 | forwarder vs a real-mimicking mock pool | `yarn test:l1` |
| 2 | mainnet fork vs real pool bytecode, verifier mocked | `yarn test:l1:fork` |
| 3 | own `ETHTornado` on a fork vs the **real verifier** | `yarn rehearsal:real-tornado` (operator) |
| 4 | Sepolia + Aztec testnet | [docs/TESTNET.md](./docs/TESTNET.md) |

Tier 3 (operator-only, see [SECURITY.md](./SECURITY.md)):

```bash
git clone https://github.com/tornadocash/tornado-cli && (cd tornado-cli && npm install)
aztec-anvil --fork-url "$MAINNET_RPC_URL"
TORNADO_CLI_DIR=/abs/path/to/tornado-cli L1_RPC_URL=http://localhost:8545 yarn rehearsal:real-tornado
```

## Security properties

- ETH leaves L1 only by consuming a valid, unreplayed L2→L1 burn message.
- `tornadoETH` mints only by consuming a valid L1→L2 deposit message, once.
- The Aztec recipient never appears on L1.
- CEI + reentrancy guard on `withdrawFromAztec`; reserves can't go negative; no plain ETH ingress.

Spec deviations and how to add another origin bridge: [docs/DESIGN.md](./docs/DESIGN.md).

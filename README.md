> [!WARNING]
> **AI-generated educational code, not audited.**
> For learning and research rather than production use. It is provided "as is", without
> warranty of any kind (see [LICENSE](./LICENSE)). A bug in the L1 portal, the forwarder or the
> Aztec contract can mint unbacked `tornadoETH` or lock or release ETH incorrectly. Do not use it
> with real funds without your own independent review. See [SECURITY.md](./SECURITY.md).

# aztec-shielded-portal

Tornado Cash → Aztec bridge PoC. ETH withdrawn from a Tornado pool is locked in an L1 portal and
minted on Aztec as private **`tornadoETH`**, 1:1 reserve-backed and redeemable back to L1.

On Aztec, withdrawals from any Tornado ETH pool (0.1, 1, 10, 100) become one private balance that
can be merged, split and redeemed in any amount, to any L1 address, over time (e.g. a 100 ETH note
redeemed in small increments, or several small notes redeemed as one).
Tornado still hides which deposit funded the mint; how well redemptions hide from each other
depends on how many other users hold `tornadoETH`.

## Flow

- **Deposit → mint.** A Tornado withdrawal into the portal locks the ETH and sends an L1→L2 message
  committed to a hidden Aztec recipient, who claims it as private `tornadoETH`.
- **Burn → redeem.** A private burn sends an L2→L1 message; once the epoch settles, anyone can relay
  it and the portal releases the ETH to the L1 recipient named in the burn.

Contract-level details are in [docs/DESIGN.md](./docs/DESIGN.md).

| Public (L1)                                  | Private (Aztec)                     |
| -------------------------------------------- | ----------------------------------- |
| A Tornado withdrawal into the bridge         | Recipient of minted `tornadoETH`    |
| Denomination and total reserves              | Note ownership and balances         |
| L1 redemption recipient + amount             | Transfers, identity of the burner   |
| Timing correlation of L1 entry and L2 mint   |                                     |

## Toolchain

- Node 22+
- Yarn 4 (`corepack enable`)
- aztec-up (also provides Foundry as `aztec-forge` / `aztec-anvil`):

```bash
curl -fsSL https://install.aztec.network | bash
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

Locally, redemption works without a prover: the local network settles each epoch synthetically,
writing its out-hash into the L1 Outbox.

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
mint (the SDK does this automatically). Each Tornado nullifier bridges at most once.

Each ETH pool gets its own `ForwarderFactory`, and the portal approves one per pool
(`approveForwarderFactory`), so all four pools mint the same `tornadoETH`.

Proofs come from Tornado's own circom1/websnark toolchain and proving key, in the isolated, opt-in
`prover/` package (see [SECURITY.md](./SECURITY.md)).

| Tier | What | Runs |
| ---- | ---- | ---- |
| 1 | forwarder vs a real-mimicking mock pool | `yarn test:l1` |
| 2 | mainnet fork vs real pool bytecode, verifier mocked | `yarn test:l1:fork` |
| 3 | mainnet fork: **real verifier**, full Aztec round trip | `yarn rehearsal:real-tornado` |
| 4 | Sepolia + Aztec testnet | [docs/TESTNET.md](./docs/TESTNET.md) |

Tier 3 deploys a copy of the 1 ETH pool on the fork (its exact bytecode, linked to the canonical
Hasher and pointed at the canonical Verifier), deposits, proves to our forwarder, and runs the local
network's L1 contracts on the same fork, so claim → burn → redeem settle against the same L1:

```bash
yarn prover:install
MAINNET_RPC_URL=https://eth.drpc.org yarn rehearsal:real-tornado
```

`--real-pool` uses the canonical pool instead, rebuilding its tree from tornado-cli's event cache plus
`getLogs`; that needs an RPC serving wide `getLogs` ranges (e.g. Alchemy with
`LOGS_MAX_RANGE=1000000`). `--l1-only` stops at the portal.

## Security properties

- ETH leaves L1 only by consuming a valid, unreplayed L2→L1 burn message.
- `tornadoETH` mints only by consuming a valid L1→L2 deposit message, once.
- The Aztec recipient never appears on L1.
- CEI + reentrancy guard on `withdrawFromAztec`; reserves can't go negative; no plain ETH ingress.

Design details and how to add another origin bridge: [docs/DESIGN.md](./docs/DESIGN.md).

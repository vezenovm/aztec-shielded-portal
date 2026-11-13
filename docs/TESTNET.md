# Testnet rehearsal (Sepolia + Aztec testnet)

The full live flow — real Tornado proof on **Sepolia** → bridge → private `tornadoETH` on **Aztec
testnet** → burn → L1 redeem. `scripts/sepolia-rehearsal.ts` is a **blueprint**: it reuses the
verified, network-agnostic flow helpers and isolates the testnet-specific bootstrap into clearly
marked seams. It has **not** been run against live testnet — the first run wires those seams (below)
and tunes timeouts.

> Mainnet is out of scope: it is gated on external audit + legal/OFAC sign-off + the fee/relayer
> redesign (relax `msg.value == denomination`). See [SECURITY.md](../SECURITY.md).

## Prerequisites

1. **A tornado-core pool on Sepolia.** Deploy it with **tornado-core's own migrations** — do *not*
   re-implement the deploy. Its migrations correctly deploy the MiMC Hasher (via circomlib
   `createCode`), the Verifier (from the trusted setup), and `ETHTornado(verifier, hasher,
   denomination, height)` at the right solc. Record the pool address → `SEPOLIA_TORNADO_POOL` and
   its deployment block → `SEPOLIA_TORNADO_POOL_DEPLOY_BLOCK`.
   (Unlike the mainnet fork, Sepolia has no canonical Verifier/Hasher on-chain, so you deploy your
   own — hence tornado-core's migrations rather than this repo's fork-only `deployOwnTornadoPool`.)
2. **The prover**: `yarn prover:install` (isolated legacy toolchain; see SECURITY.md).
3. **Sepolia signer**: a funded EOA (`L1_PRIVATE_KEY`), an RPC (`L1_RPC_URL`), `L1_CHAIN_ID=11155111`.
4. **Aztec testnet**: the node URL (`AZTEC_NODE_URL`) and a funded account.

## Run

```bash
export SEPOLIA_TORNADO_POOL=0x...            # from tornado-core migrations
export SEPOLIA_TORNADO_POOL_DEPLOY_BLOCK=...
export L1_RPC_URL=https://sepolia...  L1_CHAIN_ID=11155111  L1_PRIVATE_KEY=0x...
export AZTEC_NODE_URL=https://...aztec-testnet...
yarn rehearsal:sepolia
```

## Seams to wire on the first live run

All three live in `scripts/sepolia-rehearsal.ts`:

1. **Aztec account bootstrap** (`registerTestnetAccount`) — testnet has **no** prefunded accounts, so
   the local `registerInitialLocalNetworkAccountsInWallet` does not apply. Deploy + fund an account
   via the testnet faucet / bridged fee juice / a sponsored FPC, and return it. Real proving
   (`proverEnabled: true`) is already set on the wallet.
2. **Fees** — every Aztec tx costs fee juice and every Sepolia tx costs ETH. The rehearsal uses one
   funded account for both `alice`/`bob`; split into two if the faucet allows, for a truer flow.
3. **Epoch settlement** — the local network settles epochs synthetically; testnet settles
   epochs for real. `getBurnWitness` already polls `computeL2ToL1MembershipWitness` (its
   `advanceL2Blocks` nudge is harmless on testnet) — it just needs a **generous timeout** (the script
   passes `1800s`; real settlement can take minutes).

## What this proves

A real circom1/websnark Tornado proof, bound to our CREATE2 forwarder, accepted by a **real
(self-deployed) Tornado verifier on a public testnet**, driving the complete
withdraw → claim → transfer → burn → redeem path across Sepolia and Aztec testnet with real proving
and real epoch settlement — the live end-to-end rung above the local sandbox and the mainnet-fork
rehearsal (`scripts/real-tornado-rehearsal.ts`), which already checks the proof against the real
mainnet verifier.

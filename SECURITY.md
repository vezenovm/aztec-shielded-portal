# Security

`aztec-shielded-portal` is an **unaudited research proof-of-concept**. Do **not** deploy it to
mainnet or use it with real funds. It targets local networks and testnet only.

## Status

- **Unaudited.** No third-party review of the contracts (`TornadoEthBridgeL1`, `Forwarder`,
  `ForwarderFactory`, `TornadoEthToken`) or the off-chain SDK.
- **Testnet-only.** Mainnet is explicitly gated on external audit + legal/OFAC sign-off + a
  fee/relayer redesign (see below).
- Pinned to a single Aztec release (`6.0.0`) across the npm packages, the `aztec-nr` tag, and
  the `aztec` toolchain.

## Known limitations & privacy caveats

- **Self-submission gas linkage.** Anyone may submit `withdrawFromAztec` (funds can only reach the
  committed recipient), but if the *recipient* submits it themselves, the gas-paying L1 EOA becomes
  linkable to the recipient. Use a relayer / fresh funded EOA to preserve withdrawal privacy.
- **Provenance is public by design.** Every wei of reserve is attributable to a Tornado withdrawal;
  only Aztec-side ownership/transfers are private (see the README privacy table).
- **`fee == 0` / `msg.value == denomination`.** Relayers are out of scope this milestone: the bridge
  accepts exactly the pool denomination with zero fee/refund. A mainnet design must relax this and
  reconcile the L2 mint amount (additive on the CREATE2-forwarder binding).
- **Timing correlation.** L1 entry and the L2 mint are linkable by timing; the PoC adds no delay.

## Real-Tornado integration

The real-Tornado proof path delegates to a **caller-supplied** `tornado-cli` checkout
(`$TORNADO_CLI_DIR`); **nothing from Tornado Cash is vendored in this repository.** Generating a real
proof requires installing tornado-cli's old, third-party (circom1/websnark) toolchain and is the
**operator's deliberate step** — it is **never run in CI**.

- The optional mainnet-acceptance rehearsal (`scripts/real-tornado-rehearsal.ts`) runs **only on a
  local anvil mainnet fork, with no real funds**, and is env-gated (`TORNADO_CLI_DIR` + `L1_RPC_URL`).
- Interacting with Tornado Cash contracts/tooling may carry legal/compliance considerations (e.g.
  OFAC); operators are responsible for compliance in their own jurisdiction. The posture here —
  external, opt-in, nothing vendored, fork-only — is a conservative engineering choice and is **not
  legal advice**.

## Reporting

This is a personal research repository. Open a GitHub issue for non-sensitive reports; for anything
sensitive, contact the maintainer directly rather than filing a public issue.

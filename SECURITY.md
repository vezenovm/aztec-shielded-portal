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
- **Provenance is public by design.** Each mint locks 1 denomination and spends a distinct Tornado
  nullifier. Only Aztec-side ownership and transfers are private (see the README privacy table).
- **`fee == 0` / `msg.value == denomination`.** Relayers are out of scope this milestone: the bridge
  accepts exactly the pool denomination with zero fee/refund. A mainnet design must relax this and
  reconcile the L2 mint amount (additive on the CREATE2-forwarder binding).
- **Timing correlation.** L1 entry and the L2 mint are linkable by timing; the PoC adds no delay.

## Real-Tornado integration

Real proofs need Tornado's old, third-party circom1/websnark toolchain. It lives in the isolated
`prover/` package and is installed only by `yarn prover:install`, **never in CI** and never by the root
install:

- Dependencies are tornado-cli's own pins (git commits of the `tornadocash/*` forks), locked in
  `prover/package-lock.json` and installed with `npm ci --ignore-scripts`. They still pull in
  circomlib's transitive `web3` (only its `web3-utils` hashing is used).
- The circuit, proving key, `ETHTornado` artifact and deposit-event cache are downloaded from
  tornado-cli at a pinned commit and checked against `prover/assets.json` (size + sha256). They are
  not committed.
- The rehearsal (`scripts/real-tornado-rehearsal.ts`) refuses to run unless its L1 is an Anvil
  mainnet fork, so it never spends real funds.
- Interacting with Tornado Cash contracts/tooling may carry legal/compliance considerations (e.g.
  OFAC); operators are responsible for compliance in their own jurisdiction. The posture here —
  external, opt-in, nothing vendored, fork-only — is a conservative engineering choice and is **not
  legal advice**.

## Reporting

This is a personal research repository. Open a GitHub issue for non-sensitive reports; for anything
sensitive, contact the maintainer directly rather than filing a public issue.

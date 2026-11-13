# Contributing

This is an unaudited research PoC (see [README](./README.md) and [SECURITY.md](./SECURITY.md)).

## Ground rules

- Everything pins to **one** Aztec version (currently `6.0.0`): the `@aztec-labs/*` +
  `@aztec-foundation/l1-artifacts` npm packages, the `aztec-nr` tags in
  `contracts/aztec/tornado_eth_token/Nargo.toml`, and the `aztec-up` toolchain (incl. `aztec-forge`).
  Bump them together.
- Noir comments must be **ASCII** (em-dashes/Unicode break `aztec compile`).
- Nothing from Tornado Cash is committed: `prover/` pins its deps (lockfile) and its circuit files
  (`prover/assets.json`, fetched by `yarn prover:install`).

## Must stay green (offline, no network)

```bash
yarn build                                  # noir compile + codegen + aztec-forge build + tsc
yarn test:l1 && yarn test:sdk && yarn test:aztec-unit
```

## Need a running local network (`aztec start --local-network`)

```bash
yarn test:aztec && yarn test:e2e
```

## Operator-only (never in CI)

The real-Tornado fork rehearsal needs `yarn prover:install` and a mainnet RPC:
`MAINNET_RPC_URL=... yarn rehearsal:real-tornado`, or `RUN_REAL_TORNADO=1 MAINNET_RPC_URL=... yarn
test:fork`. See [SECURITY.md](./SECURITY.md).

Regenerating `prover/package-lock.json`: `npm --prefix prover install --ignore-scripts`, then rewrite
its `git+ssh://git@github.com/` URLs to `git+https://github.com/` so `npm ci` works without SSH keys.

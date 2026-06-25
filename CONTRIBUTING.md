# Contributing

This is an unaudited research PoC (see [README](./README.md) and [SECURITY.md](./SECURITY.md)).

## Ground rules

- Everything pins to **one** Aztec version (currently `5.0.0-rc.1`): the `@aztec/*` npm packages, the
  `aztec-nr` tags in `contracts/aztec/tornado_eth_token/Nargo.toml`, and the `aztec` CLI. Bump them
  together.
- Noir comments must be **ASCII** (em-dashes/Unicode break `aztec compile`).
- Nothing from Tornado Cash is vendored — the real-proof path uses a caller-supplied `tornado-cli`.

## Must stay green (offline, no network)

```bash
yarn build                                  # noir compile + codegen + forge build + tsc
yarn test:l1 && yarn test:sdk && yarn test:aztec-unit
```

## Need a running local network (`aztec start --local-network`)

```bash
yarn test:aztec && yarn test:e2e
```

## Operator-only (never in CI)

The real-Tornado fork rehearsal (`yarn test:fork` / `yarn rehearsal:real-tornado`) needs a BYO
`tornado-cli` (`$TORNADO_CLI_DIR`) and a mainnet fork. See [SECURITY.md](./SECURITY.md).

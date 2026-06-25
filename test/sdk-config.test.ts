import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  DEFAULT_L1_CHAIN_ID,
  DEFAULT_L1_RPC_URL,
  TEST_MNEMONIC,
  resolveL1ClientConfig,
} from '../src/index.js';

const ENV_KEYS = ['L1_RPC_URL', 'L1_CHAIN_ID', 'L1_CHAIN_NAME', 'L1_PRIVATE_KEY', 'L1_MNEMONIC'] as const;
const originalEnv = new Map<(typeof ENV_KEYS)[number], string | undefined>();

describe('L1 client config', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const original = originalEnv.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    originalEnv.clear();
  });

  it('uses local Anvil defaults without signer env vars', () => {
    const config = resolveL1ClientConfig();

    assert.deepEqual(config.rpcUrls, [DEFAULT_L1_RPC_URL]);
    assert.equal(config.chainId, DEFAULT_L1_CHAIN_ID);
    assert.equal(config.chain.id, DEFAULT_L1_CHAIN_ID);
    assert.equal(config.signer, TEST_MNEMONIC);
  });

  it('requires an explicit signer for non-local chain config', () => {
    assert.throws(
      () => resolveL1ClientConfig({ rpcUrl: 'https://rpc.example.invalid', chainId: 11155111 }),
      /Set L1_PRIVATE_KEY or L1_MNEMONIC/,
    );
  });

  it('prefers a private key over a mnemonic', () => {
    const privateKey = `0x${'11'.repeat(32)}` as const;
    const config = resolveL1ClientConfig({
      rpcUrl: 'https://rpc.example.invalid',
      chainId: 11155111,
      privateKey,
      mnemonic: TEST_MNEMONIC,
    });

    assert.equal(config.signer, privateKey);
    assert.equal(config.chain.id, 11155111);
  });

  it('accepts chain config from env vars', () => {
    process.env.L1_RPC_URL = 'https://rpc.example.invalid';
    process.env.L1_CHAIN_ID = '11155111';
    process.env.L1_CHAIN_NAME = 'Sepolia-like';
    process.env.L1_MNEMONIC = TEST_MNEMONIC;

    const config = resolveL1ClientConfig();

    assert.deepEqual(config.rpcUrls, ['https://rpc.example.invalid']);
    assert.equal(config.chain.id, 11155111);
    assert.equal(config.chain.name, 'Sepolia-like');
    assert.equal(config.signer, TEST_MNEMONIC);
  });
});

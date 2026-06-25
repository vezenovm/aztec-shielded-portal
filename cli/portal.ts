#!/usr/bin/env -S node --import tsx
/**
 * `portal` CLI -- the full protocol lifecycle without a frontend, as thin wrappers over the SDK.
 *
 * Commands: setup | generate-secret | generate-commitment | withdraw-to-portal | claim | transfer |
 * burn | redeem. State (addresses, deposits, burns) persists to a JSON file (PORTAL_STATE env or
 * ./portal-state.json), so each command can run as a separate invocation. Targets a running local
 * network (`aztec start --local-network`) by default; L1 signer/endpoint come from the usual env vars
 * (L1_RPC_URL, L1_PRIVATE_KEY/L1_MNEMONIC, AZTEC_NODE_URL).
 *
 * Usage: `yarn portal <command> [flags]`  e.g. `yarn portal setup --real`
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

import { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import { EthAddress } from '@aztec/foundation/eth-address';
import { TxHash } from '@aztec/stdlib/tx';

import {
  ONE_ETH,
  TornadoEthTokenContract,
  balanceOfPrivate,
  burnForL1Withdrawal,
  claimTornadoEth,
  computeAztecMintCommitment,
  connectToAztec,
  generateMintSecret,
  getBurnWitness,
  getTotalLockedEth,
  makeL1Client,
  makeMessageConsumable,
  setupBridgeStack,
  withdrawFromMockRealPool,
  withdrawFromTornadoToBridge,
  withdrawFromAztecOnL1,
  type BurnForWithdrawal,
  type TornadoDeposit,
} from '../src/index.js';

/* ------------------------------- State file ------------------------------- */

interface StoredDeposit {
  depositId: `0x${string}`;
  mintSecret: string;
  commitment: string;
  nullifierHash: `0x${string}`;
  messageHash: string;
  messageLeafIndex: string;
  amount: string;
}

interface StoredBurn {
  nonce: string;
  recipientL1: string;
  amount: string;
  messageLeaf: string;
  txHash: string;
}

interface PortalState {
  mode: 'mock' | 'real';
  denomination: string;
  pool: `0x${string}`;
  bridge: `0x${string}`;
  token: string;
  factory?: `0x${string}`;
  mockKnownRoot?: `0x${string}`;
  deposits: StoredDeposit[];
  burns: StoredBurn[];
}

const STATE_PATH = process.env.PORTAL_STATE ?? 'portal-state.json';

function loadState(): PortalState {
  if (!existsSync(STATE_PATH)) {
    throw new Error(`No state at ${STATE_PATH}. Run \`portal setup\` first.`);
  }
  return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as PortalState;
}

function saveState(state: PortalState): void {
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function storeDeposit(d: TornadoDeposit): StoredDeposit {
  return {
    depositId: d.depositId,
    mintSecret: d.mintSecret.toString(),
    commitment: d.commitment.toString(),
    nullifierHash: d.nullifierHash,
    messageHash: d.messageHash.toString(),
    messageLeafIndex: d.messageLeafIndex.toString(),
    amount: d.amount.toString(),
  };
}

function restoreDeposit(d: StoredDeposit): TornadoDeposit {
  return {
    depositId: d.depositId,
    mintSecret: Fr.fromHexString(d.mintSecret),
    commitment: Fr.fromHexString(d.commitment),
    nullifierHash: d.nullifierHash,
    messageHash: Fr.fromHexString(d.messageHash),
    messageLeafIndex: BigInt(d.messageLeafIndex),
    amount: BigInt(d.amount),
  };
}

/* ------------------------------- Arg parsing ------------------------------ */

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

function requireFlag(flags: Record<string, string | boolean>, name: string): string {
  const value = flags[name];
  if (typeof value !== 'string') {
    throw new Error(`--${name} <value> is required`);
  }
  return value;
}

/* --------------------------- Stack reconstruction -------------------------- */

async function loadStack(state: PortalState) {
  const l1Client = makeL1Client();
  const conn = await connectToAztec();
  const token = await TornadoEthTokenContract.at(AztecAddress.fromString(state.token), conn.wallet);
  return {
    l1Client,
    node: conn.node,
    wallet: conn.wallet,
    accounts: conn.accounts,
    pool: state.pool,
    bridge: state.bridge,
    token,
    denomination: BigInt(state.denomination),
    factory: state.factory,
    mockKnownRoot: state.mockKnownRoot,
  };
}

function pickAccount(accounts: AztecAddress[], flag: string | boolean | undefined): AztecAddress {
  if (typeof flag === 'string') {
    return /^0x/.test(flag) ? AztecAddress.fromString(flag) : accounts[Number(flag)];
  }
  return accounts[0];
}

/* -------------------------------- Commands -------------------------------- */

async function cmdSetup(flags: Record<string, string | boolean>): Promise<void> {
  const useRealTornado = flags.real === true;
  const stack = await setupBridgeStack({ useRealTornado });
  const state: PortalState = {
    mode: useRealTornado ? 'real' : 'mock',
    denomination: stack.denomination.toString(),
    pool: stack.pool,
    bridge: stack.bridge,
    token: stack.token.address.toString(),
    factory: stack.factory,
    mockKnownRoot: stack.mockKnownRoot,
    deposits: [],
    burns: [],
  };
  saveState(state);
  console.log(`Stack deployed (${state.mode} mode). State -> ${STATE_PATH}`);
  console.log(`  bridge: ${state.bridge}`);
  console.log(`  pool:   ${state.pool}`);
  if (state.factory) console.log(`  factory:${state.factory}`);
  console.log(`  token:  ${state.token}`);
}

function cmdGenerateSecret(): void {
  console.log(generateMintSecret().toString());
}

async function cmdGenerateCommitment(flags: Record<string, string | boolean>): Promise<void> {
  const recipient = AztecAddress.fromString(requireFlag(flags, 'recipient'));
  const secret = Fr.fromHexString(requireFlag(flags, 'secret'));
  const amount = BigInt((flags.amount as string) ?? ONE_ETH.toString());
  console.log((await computeAztecMintCommitment(recipient, secret, amount)).toString());
}

async function cmdWithdrawToPortal(flags: Record<string, string | boolean>): Promise<void> {
  const state = loadState();
  const stack = await loadStack(state);
  const recipient = pickAccount(stack.accounts, flags.recipient);

  const deposit =
    state.mode === 'real'
      ? await withdrawFromMockRealPool(stack, recipient)
      : await withdrawFromTornadoToBridge(stack, recipient);

  state.deposits.push(storeDeposit(deposit));
  saveState(state);
  console.log(`Withdrew to portal. depositId=${deposit.depositId}`);
  console.log(`Locked reserve: ${await getTotalLockedEth(stack.l1Client, state.bridge)} wei`);
}

async function cmdClaim(flags: Record<string, string | boolean>): Promise<void> {
  const state = loadState();
  const stack = await loadStack(state);
  const recipient = pickAccount(stack.accounts, flags.recipient);
  const index = flags.deposit !== undefined ? Number(flags.deposit) : state.deposits.length - 1;
  const stored = state.deposits[index];
  if (!stored) throw new Error('No deposit to claim (run withdraw-to-portal first).');
  const deposit = restoreDeposit(stored);

  await makeMessageConsumable(stack, deposit, recipient);
  await claimTornadoEth(stack.token, recipient, deposit);
  console.log(`Claimed. balance(${recipient.toString()}) = ${await balanceOfPrivate(stack.token, recipient)}`);
}

async function cmdTransfer(flags: Record<string, string | boolean>): Promise<void> {
  const state = loadState();
  const stack = await loadStack(state);
  const from = pickAccount(stack.accounts, flags.from);
  const to = AztecAddress.fromString(requireFlag(flags, 'to'));
  const amount = BigInt(requireFlag(flags, 'amount'));
  await stack.token.methods.transfer_private(to, amount).send({ from });
  console.log(`Transferred ${amount} wei. balance(from)=${await balanceOfPrivate(stack.token, from)}`);
}

async function cmdBurn(flags: Record<string, string | boolean>): Promise<void> {
  const state = loadState();
  const stack = await loadStack(state);
  const from = pickAccount(stack.accounts, flags.from);
  const recipientL1 = requireFlag(flags, 'recipient-l1') as `0x${string}`;
  const amount = BigInt(requireFlag(flags, 'amount'));

  const burn = await burnForL1Withdrawal(stack, from, recipientL1, amount);
  state.burns.push({
    nonce: burn.nonce.toString(),
    recipientL1: burn.recipientL1.toString(),
    amount: burn.amount.toString(),
    messageLeaf: burn.messageLeaf.toString(),
    txHash: burn.receipt.txHash.toString(),
  });
  saveState(state);
  console.log(`Burned ${amount} wei for L1 ${recipientL1}.`);

  if (flags.redeem === true) {
    await redeem(stack, from, burn);
  } else {
    console.log('Run `portal redeem` once the epoch settles to release the ETH on L1.');
  }
}

async function cmdRedeem(flags: Record<string, string | boolean>): Promise<void> {
  const state = loadState();
  const stack = await loadStack(state);
  const blockProducer = pickAccount(stack.accounts, flags['block-producer']);
  const index = flags.burn !== undefined ? Number(flags.burn) : state.burns.length - 1;
  const stored = state.burns[index];
  if (!stored) throw new Error('No burn to redeem (run burn first).');

  // Re-fetch the burn tx receipt so getBurnWitness can locate the settled L2->L1 message.
  const receipt = await stack.node.getTxReceipt(TxHash.fromString(stored.txHash));
  const burn: BurnForWithdrawal = {
    receipt,
    nonce: Fr.fromHexString(stored.nonce),
    recipientL1: EthAddress.fromString(stored.recipientL1),
    amount: BigInt(stored.amount),
    messageLeaf: Fr.fromHexString(stored.messageLeaf),
  };
  await redeem(stack, blockProducer, burn);
}

async function redeem(
  stack: Awaited<ReturnType<typeof loadStack>>,
  blockProducer: AztecAddress,
  burn: BurnForWithdrawal,
): Promise<void> {
  console.log('Waiting for the burn epoch to settle into the L1 Outbox...');
  const witness = await getBurnWitness(stack, burn, blockProducer);
  await withdrawFromAztecOnL1(stack, burn, witness);
  console.log(`Redeemed ${burn.amount} wei to ${burn.recipientL1.toString()} on L1.`);
  console.log(`Remaining reserve: ${await getTotalLockedEth(stack.l1Client, stack.bridge)} wei`);
}

/* --------------------------------- Dispatch -------------------------------- */

const HELP = `portal <command> [flags]

  setup [--real]                                  deploy + wire the full stack (mock | forwarder path)
  generate-secret                                 print a fresh mint secret
  generate-commitment --recipient <a> --secret <s> [--amount <wei>]
  withdraw-to-portal [--recipient <idx|addr>]     withdraw from the pool into the bridge
  claim [--deposit <idx>] [--recipient <idx|addr>]
  transfer --to <addr> --amount <wei> [--from <idx|addr>]
  burn --recipient-l1 <0x> --amount <wei> [--from <idx|addr>] [--redeem]
  redeem                                          (use \`burn --redeem\`; see README)
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  switch (command) {
    case 'setup':
      return cmdSetup(flags);
    case 'generate-secret':
      return cmdGenerateSecret();
    case 'generate-commitment':
      return cmdGenerateCommitment(flags);
    case 'withdraw-to-portal':
      return cmdWithdrawToPortal(flags);
    case 'claim':
      return cmdClaim(flags);
    case 'transfer':
      return cmdTransfer(flags);
    case 'burn':
      return cmdBurn(flags);
    case 'redeem':
      return cmdRedeem(flags);
    default:
      console.log(HELP);
      if (command && command !== 'help' && command !== '--help') process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

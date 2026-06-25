/** Tiny shared read/write for config.local.json (deployed addresses). */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface LocalConfig {
  pool?: `0x${string}`;
  bridge?: `0x${string}`;
  l2Token?: string;
  denomination?: string;
}

const CONFIG_PATH = resolve(import.meta.dirname, '../config.local.json');

export function readConfig(): LocalConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as LocalConfig;
  } catch {
    return {};
  }
}

export function writeConfig(update: LocalConfig): LocalConfig {
  const merged = { ...readConfig(), ...update };
  writeFileSync(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`wrote ${CONFIG_PATH}`);
  return merged;
}

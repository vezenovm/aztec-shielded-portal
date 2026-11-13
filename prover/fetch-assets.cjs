#!/usr/bin/env node
/**
 * Fetch the tornado-cli files listed in assets.json into prover/assets/, verifying size + sha256.
 * `--check` only verifies what is already on disk. Exits non-zero on any mismatch.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const manifest = require('./assets.json');
const ASSETS_DIR = path.join(__dirname, 'assets');

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function verify(rel) {
  const file = path.join(ASSETS_DIR, rel);
  const want = manifest.files[rel];
  if (!fs.existsSync(file)) return `missing ${rel}`;
  if (fs.statSync(file).size !== want.size) return `size mismatch ${rel}`;
  if (digest(file) !== want.sha256) return `sha256 mismatch ${rel}`;
  return null;
}

async function download(rel) {
  const res = await fetch(`${manifest.source}/${manifest.commit}/${rel}`);
  if (!res.ok) throw new Error(`GET ${rel}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const want = manifest.files[rel];
  const got = crypto.createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== want.size || got !== want.sha256) {
    throw new Error(`${rel}: downloaded bytes do not match the manifest (sha256 ${got})`);
  }
  const file = path.join(ASSETS_DIR, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, bytes);
  fs.renameSync(`${file}.tmp`, file);
}

(async () => {
  const checkOnly = process.argv.includes('--check');
  const failures = [];
  for (const rel of Object.keys(manifest.files)) {
    let err = verify(rel);
    if (err && !checkOnly) {
      await download(rel);
      err = verify(rel);
    }
    if (err) failures.push(err);
    else console.log(`ok ${rel}`);
  }
  if (failures.length) {
    console.error(failures.join('\n'));
    console.error(checkOnly ? 'Run `yarn prover:install`.' : '');
    process.exit(1);
  }
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});

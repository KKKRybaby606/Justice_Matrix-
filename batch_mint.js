#!/usr/bin/env node
/**
 * batch_mint.js
 *
 * Tier-2 batch mint script with:
 *  - Parallel CID resolution
 *  - Per-wallet nonce allocation
 *  - Retry + exponential backoff
 *  - Optional RBF (replace-by-fee) mode to raise maxFeePerGas on retries
 *  - Offline mode: produce unsigned_tx_<index>.json and unsigned_serialized_<index>.txt for Ledger signing
 *  - Rate-limited batch broadcasting
 *  - Full JSONL audit log per event
 *
 * Usage (local signing):
 *   RPC_URL and PRIVATE_KEY in .env
 *   node batch_mint.js --input recipients.json --contract 0xContractAddress
 *
 * Usage (offline mode for Ledger signing):
 *   node batch_mint.js --input recipients.json --contract 0xContractAddress --mode offline --unsignedDir unsigned_out
 *   This will produce unsigned_tx_<index>.json files compatible with hw-ledger-sign.js
 *
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ethers } = require('ethers');

// CLI parsing
const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const key = argv[i].slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true';
    args[key] = val;
    if (val !== 'true') i++;
  }
}

function usageAndExit(msg) {
  if (msg) console.error(msg);
  console.error('Usage: node batch_mint.js --input recipients.json --contract 0xCONTRACT [--mode local|offline] [--concurrency 6] [--broadcastConcurrency 2] [--rbf true] ...');
  process.exit(1);
}

if (!args.input) usageAndExit('Missing --input');
if (!args.contract) usageAndExit('Missing --contract');

const INPUT_PATH = args.input;
const CONTRACT_ADDRESS = args.contract;
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const MODE = args.mode || 'local'; // 'local' or 'offline'

if (!RPC_URL) usageAndExit('RPC_URL environment variable not set');
if (MODE === 'local' && !PRIVATE_KEY) usageAndExit('PRIVATE_KEY required for local signing mode');

const CID_RESOLVE_CONCURRENCY = parseInt(args.concurrency || '6', 10);
const BROADCAST_CONCURRENCY = parseInt(args.broadcastConcurrency || '2', 10);
const RATE_LIMIT_MS = parseInt(args.rateLimitMs || '500', 10);
const MAX_RETRIES = parseInt(args.maxRetries || '3', 10);
const CONFIRMATIONS = parseInt(args.confirmations || '1', 10);
const LOG_PATH = args.log || 'batch_mint_log.jsonl';
const IPFS_GATEWAY = args.gateway || 'https://ipfs.io/ipfs';
const UNSIGNED_OUT_DIR = args.unsignedDir || 'unsigned_out';
const RBF_ENABLED = (args.rbf === 'true' || args.rbf === true);
const RBF_MULTIPLIER = parseFloat(args.rbfMultiplier || '1.5');
const RBF_MAX_GWEI = parseFloat(args.rbfMaxGwei || '200');

const INPUT = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf8'));
if (!Array.isArray(INPUT) || INPUT.length === 0) usageAndExit('Input must be non-empty JSON array');

// ABI - adjust if needed
const ABI = ['function safeMint(address to, string memory uri) public returns (uint256)'];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = MODE === 'local' ? new ethers.Wallet(PRIVATE_KEY, provider) : null;
const contractIface = new ethers.Interface(ABI);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function sha256Hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function ipfsToGateway(uri) { if (!uri) return uri; if (uri.startsWith('ipfs://')) return uri.replace('ipfs://', IPFS_GATEWAY + '/'); return uri; }

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = new Array(Math.min(concurrency, items.length)).fill(null).map(async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function resolveAllMetadata(list) {
  const results = await mapWithConcurrency(list, CID_RESOLVE_CONCURRENCY, async (item, i) => {
    const uri = item.metadata;
    const url = ipfsToGateway(uri);
    const record = { index: i, to: item.to, metadata: uri, url, ok: false, status: null, sha256: null, size: null, error: null };
    try {
      const res = await fetch(url, { method: 'GET' });
      record.status = res.status;
      if (!res.ok) {
        record.error = `HTTP ${res.status}`;
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        record.sha256 = sha256Hex(buf);
        record.size = buf.length;
        record.ok = true;
        try { const json = JSON.parse(buf.toString('utf8')); record.parsed_name = json.name || null; record.parsed_image = json.image || null; } catch (e) { record.note = 'metadata not JSON'; }
      }
    } catch (err) { record.error = String(err); }
    console.log(`Resolved [${i}] to=${item.to} -> ${record.ok ? 'OK' : 'FAIL'} ${record.status || ''} ${record.error || ''}`);
    return record;
  });
  return results;
}

function appendLog(obj) { fs.appendFileSync(LOG_PATH, JSON.stringify(obj) + '\n', 'utf8'); }

async function main() {
  const resolved = await resolveAllMetadata(INPUT);
  const failures = resolved.filter(r => !r.ok);
  if (failures.length > 0) {
    console.warn(`Warning: ${failures.length} metadata URIs failed to resolve. Aborting.`);
    failures.forEach(f => console.warn(`Index ${f.index} to=${f.to} metadata=${f.metadata} error=${f.error}`));
    process.exit(1);
  }

  const network = await provider.getNetwork();
  console.log('Connected to chainId', network.chainId, 'network', network.name);
  let nextNonce = await provider.getTransactionCount(MODE === 'local' ? wallet.address : '0x0', 'pending');
  // For offline mode we still want to allocate nonces deterministically from a provided start nonce via --startNonce or 0
  if (MODE === 'offline') {
    const startNonceArg = args.startNonce;
    if (startNonceArg) nextNonce = parseInt(startNonceArg, 10);
    else {
      // If no startNonce provided, we attempt to query a 'reference' address if provided
      if (args.refAddress) {
        nextNonce = await provider.getTransactionCount(args.refAddress, 'pending');
        console.log('Using refAddress nonce as startNonce:', nextNonce);
      } else {
        console.warn('Offline mode with no startNonce or refAddress; defaulting startNonce to 0 — make sure to set correct nonce before signing.');
        nextNonce = 0;
      }
    }
  }
  console.log('Starting nonce (pending/start):', nextNonce);

  function allocateNonce() { const n = nextNonce; nextNonce++; return n; }

  const tasks = INPUT.map((entry, idx) => ({ index: idx, toRecipient: entry.to, metadata: entry.metadata, data: contractIface.encodeFunctionData('safeMint', [entry.to, entry.metadata]) }));

  if (MODE === 'offline') {
    if (!fs.existsSync(UNSIGNED_OUT_DIR)) fs.mkdirSync(UNSIGNED_OUT_DIR, { recursive: true });
  }

  for (let start = 0; start < tasks.length; start += BROADCAST_CONCURRENCY) {
    const batch = tasks.slice(start, start + BROADCAST_CONCURRENCY);
    const promises = batch.map(task => (async () => {
      const logBase = { timestamp: new Date().toISOString(), index: task.index, to: task.toRecipient, metadata: task.metadata, contract: CONTRACT_ADDRESS };
      const nonce = allocateNonce();
      logBase.nonce = nonce;

      const feeData = await provider.getFeeData();
      let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.parseUnits('2', 'gwei');
      let maxFeePerGas = feeData.maxFeePerGas || ethers.parseUnits('30', 'gwei');

      // Estimate gas
      let gasLimit;
      try {
        const est = await provider.estimateGas({ to: CONTRACT_ADDRESS, from: MODE === 'local' ? wallet.address : undefined, data: task.data, value: 0 });
        gasLimit = est * 120n / 100n;
      } catch (e) { gasLimit = 300000n; }

      const baseTx = { type: 2, to: CONTRACT_ADDRESS, nonce, gasLimit: gasLimit.toString(), maxPriorityFeePerGas: maxPriorityFeePerGas.toString(), maxFeePerGas: maxFeePerGas.toString(), value: '0x0', data: task.data, chainId: network.chainId };

      if (MODE === 'offline') {
        // write unsigned_tx_<index>.json and unsigned_serialized_<index>.txt
        const unsignedPath = path.join(UNSIGNED_OUT_DIR, `unsigned_tx_${task.index}.json`);
        fs.writeFileSync(unsignedPath, JSON.stringify(baseTx, null, 2));
        const serialized = ethers.utils.serializeTransaction(baseTx);
        fs.writeFileSync(path.join(UNSIGNED_OUT_DIR, `unsigned_serialized_${task.index}.txt`), serialized);
        appendLog({ ...logBase, event: 'unsigned_written', unsignedPath });
        return { ...logBase, status: 'unsigned_written', unsignedPath };
      }

      // MODE === 'local' -> sign and send with retries and optional RBF
      let attempt = 0;
      let result = { ...logBase, attempt, status: 'pending' };

      let currentMaxFee = ethers.BigInt(maxFeePerGas);
      const maxGweiCap = ethers.parseUnits(String(RBF_MAX_GWEI), 'gwei');

      while (attempt < MAX_RETRIES) {
        attempt++;
        result.attempt = attempt;
        try {
          // Update tx with current maxFee
          const tx = Object.assign({}, baseTx, { maxFeePerGas: currentMaxFee.toString() });
          // Sign
          const signed = await wallet.signTransaction(tx);
          // Send
          const resp = await provider.sendTransaction(signed);
          result.txHash = resp.hash; result.sentAt = new Date().toISOString(); result.status = 'sent';
          appendLog({ ...result, event: 'sent' });
          // Wait for confirmation
          try {
            const receipt = await resp.wait(CONFIRMATIONS);
            result.receipt = receipt; result.status = receipt && receipt.status === 1 ? 'confirmed' : 'failed'; result.confirmedAt = new Date().toISOString();
            appendLog({ ...result, event: 'confirmed' });
            return result;
          } catch (waitErr) {
            appendLog({ ...result, event: 'wait_error', error: String(waitErr) });
            console.warn('Wait error:', waitErr);
            // prepare to retry (may need RBF bump)
          }
        } catch (sendErr) {
          appendLog({ ...result, event: 'send_error', error: String(sendErr) });
          console.warn('Send error attempt', attempt, sendErr);
        }

        // RBF logic: bump maxFeePerGas if enabled
        if (RBF_ENABLED) {
          // multiply by RBF_MULTIPLIER but cap to RBF_MAX_GWEI
          const bumped = ethers.BigInt((Number(currentMaxFee) * RBF_MULTIPLIER) | 0);
          currentMaxFee = bumped > maxGweiCap ? maxGweiCap : bumped;
          appendLog({ ...result, event: 'rbf_bump', attempt, newMaxFee: currentMaxFee.toString() });
        }

        const backoff = 1000 * Math.pow(2, attempt - 1);
        await sleep(backoff);
      }

      result.status = 'error'; appendLog({ ...result, event: 'final' });
      return result;
    })());

    const results = await Promise.all(promises);
    fs.appendFileSync(LOG_PATH, JSON.stringify({ timestamp: new Date().toISOString(), batchStart: start, batchSize: batch.length, resultsSummary: results.map(r => ({ index: r.index, status: r.status, txHash: r.txHash || null })) }) + '\n');

    if (start + BROADCAST_CONCURRENCY < tasks.length) await sleep(RATE_LIMIT_MS);
  }

  console.log('Processing complete. Audit log at', path.resolve(LOG_PATH));
}

main().catch(err => { console.error('Fatal batch mint error:', err); process.exit(1); });

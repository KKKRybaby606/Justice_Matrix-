#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const { ethers } = require('ethers');

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 1) {
    console.error('Usage: node hw-ledger-sign.js <unsigned_tx.json> [derivation_path]');
    process.exit(1);
  }

  const unsignedPath = argv[0];
  const derivationPath = argv[1] || "m/44'/60'/0'/0/0";

  if (!fs.existsSync(unsignedPath)) {
    console.error('File not found:', unsignedPath);
    process.exit(1);
  }

  const unsignedTx = JSON.parse(fs.readFileSync(unsignedPath, 'utf8'));

  // Serialize the unsigned transaction (ethers will produce the RLP unsigned payload)
  const unsignedSerialized = ethers.utils.serializeTransaction(unsignedTx);
  const serializedHex = unsignedSerialized.startsWith('0x') ? unsignedSerialized.slice(2) : unsignedSerialized;

  // Ledger dependencies (node-hid) and eth app
  const TransportNodeHid = require('@ledgerhq/hw-transport-node-hid').default;
  const AppEth = require('@ledgerhq/hw-app-eth').default;

  console.log('Connecting to Ledger (unlock device and open the Ethereum app)...');
  const transport = await TransportNodeHid.create();
  const appEth = new AppEth(transport);

  console.log('Requesting Ledger to sign the transaction. Confirm on the device when prompted.');
  // signTransaction expects the raw RLP of the unsigned transaction (hex without 0x)
  const signature = await appEth.signTransaction(derivationPath, serializedHex);

  // signature contains r, s, v as hex strings (v may be decimal string on some firmwares)
  const sig = {
    v: signature.v.startsWith('0x') ? signature.v : '0x' + signature.v,
    r: signature.r.startsWith('0x') ? signature.r : '0x' + signature.r,
    s: signature.s.startsWith('0x') ? signature.s : '0x' + signature.s,
  };

  // Serialize the final signed transaction
  const signedTx = ethers.utils.serializeTransaction(unsignedTx, sig);

  fs.writeFileSync('signed_tx.txt', signedTx);
  fs.writeFileSync('signed_tx.json', JSON.stringify({ signedTx, signature: sig }, null, 2));

  console.log('Signed transaction saved as signed_tx.txt and signed_tx.json.');
  await transport.close();
}

main().catch(err => {
  console.error('Error in hw-ledger-sign:', err);
  process.exit(1);
});

const { ethers } = require('ethers');
const fs = require('fs');
require('dotenv').config();

async function main() {
  const RPC_URL = process.env.RPC_URL;
  if (!RPC_URL) {
    console.error('RPC_URL not set. Example: export RPC_URL="https://rpc-mumbai.maticvigil.com"');
    process.exit(1);
  }

  const signedPath = process.env.SIGNED_TX_PATH || 'signed_tx.txt';
  if (!fs.existsSync(signedPath)) {
    console.error('Signed transaction file not found:', signedPath);
    process.exit(1);
  }

  const signedRaw = fs.readFileSync(signedPath, 'utf8').trim();
  if (!signedRaw.startsWith('0x')) {
    console.warn('Signed tx does not start with 0x. Prepending...');
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  console.log('Broadcasting signed transaction to', RPC_URL);

  try {
    const txResponse = await provider.sendTransaction(signedRaw);
    console.log('tx.hash =', txResponse.hash);
    console.log('Waiting for confirmation...');
    const receipt = await txResponse.wait();
    console.log('Transaction confirmed in block', receipt.blockNumber);
    console.log('Receipt:', receipt);
  } catch (err) {
    console.error('Error broadcasting transaction:', err);
    process.exit(1);
  }
}

main();
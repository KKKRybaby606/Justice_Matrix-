const { ethers } = require('ethers');

if (process.argv.length < 4) {
  console.error('Usage: node encode_mint_data.js <TO_ADDRESS> <METADATA_URI>');
  process.exit(1);
}

const to = process.argv[2];
const tokenURI = process.argv[3];

const abi = ['function safeMint(address to, string memory uri) public returns (uint256)'];
const iface = new ethers.utils.Interface(abi);

const data = iface.encodeFunctionData('safeMint', [to, tokenURI]);

console.log('DATA_FIELD =', data);

// Optionally write to file
const fs = require('fs');
fs.writeFileSync('data.hex', data);
console.log('Wrote data.hex');
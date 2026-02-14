## Ledger offline signing

This section describes how to sign an unsigned transaction (`unsigned_tx.json`) using a Ledger hardware wallet (offline) and then broadcast the signed transaction from an online machine.

Prerequisites
- Node.js >= 18
- A Ledger device with the Ethereum app installed and open
- On the offline machine (with Ledger attached): install dependencies:
  npm install @ledgerhq/hw-transport-node-hid @ledgerhq/hw-app-eth ethers@^6 dotenv
- Ensure `unsigned_tx.json` (created by `build_unsigned_tx.js`) is transferred securely to the offline machine. Verify checksum (sha256) before and after transfer.

Usage example (offline signer with Ledger)
1. Connect Ledger via USB and open the Ethereum app on the device.
2. Run the signing helper (defaults to derivation path m/44'/60'/0'/0/0):
   node hardhat/tools/hw-ledger-sign.js unsigned_tx.json "m/44'/60'/0'/0/0"

What the script does
- Connects to the Ledger using node-hid transport
- Requests the Ledger to sign the unsigned transaction
- Writes two files to the working directory:
  - `signed_tx.txt` — the raw signed transaction (hex) ready for broadcast
  - `signed_tx.json` — JSON object with the signed transaction and signature components (v, r, s)

Broadcasting the signed transaction (online machine)
- Transfer `signed_tx.txt` to an online machine (verify checksum after transfer)
- Use either Node broadcast helper:
  export RPC_URL="https://rpc-mumbai.maticvigil.com"
  node broadcast_signed.js
  or PowerShell helper:
  $Env:RPC_URL = 'https://rpc-mumbai.maticvigil.com'
  .\broadcast_signed.ps1

Safety notes and best practices
- Keep the signing machine air-gapped if possible. Attach the Ledger only when ready to sign.
- Verify unsigned_tx.json checksum before and after transfer to the offline machine.
- Confirm the expected signer address and transaction summary on the Ledger display before approving the signature.
- Test the entire flow on Mumbai (testnet) before signing or broadcasting on mainnet.
- Do not commit private keys, .env files, or signed_tx.txt to the repository.

References
- Issue / provenance: https://github.com/KKKRybaby606/Justice_Matrix-/issues/73

End of section.

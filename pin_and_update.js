const { NFTStorage, File } = require('nft.storage');
const fs = require('fs');
const path = require('path');

const NFT_STORAGE_API_KEY = process.env.NFT_STORAGE_API_KEY;

async function pinFiles() {
    const client = new NFTStorage({ token: NFT_STORAGE_API_KEY });

    const filesToPin = ['matrix.md', 'justice-timeline.dot', 'justice-timeline.json', 'matrix.json', 'nft-metadata.json', 'DISCLAIMER.md'];
    let cids = {};

    for (const fileName of filesToPin) {
        const filePath = path.join(__dirname, fileName);
        const metadata = fs.readFileSync(filePath);
        const cid = await client.storeDirectory([new File([metadata], fileName)]);
        cids[fileName] = cid;
    }

    let matrixJson = JSON.parse(fs.readFileSync('matrix.json'));
    let metadataJson = JSON.parse(fs.readFileSync('nft-metadata.json'));

    // Replace placeholders with actual CIDs
    matrixJson.cidPlaceholder = cids['matrix.json'];
    metadataJson.cidPlaceholder = cids['nft-metadata.json'];

    fs.writeFileSync('cids.json', JSON.stringify(cids, null, 2));
    fs.writeFileSync('matrix.json', JSON.stringify(matrixJson, null, 2));
    fs.writeFileSync('nft-metadata.json', JSON.stringify(metadataJson, null, 2));
}

pinFiles();

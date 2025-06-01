async function main() {
  // We get the contract to deploy
  const JusticeMatrix = await ethers.getContractFactory("JusticeMatrix");
  const justiceMatrix = await JusticeMatrix.deploy();

  await justiceMatrix.deployed();

  console.log("JusticeMatrix deployed to:", justiceMatrix.address);
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });

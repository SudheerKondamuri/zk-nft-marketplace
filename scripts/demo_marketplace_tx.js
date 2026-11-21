const { ethers } = require("hardhat");
const { generateProofData, formatSolidityCalldata } = require("./generate_proof");
const { randomFieldElement } = require("./zk_utils");
const snarkjs = require("snarkjs");

async function main() {
    console.log("===============================================================================");
    console.log("  ZK-SNARK NFT Marketplace: Confidential Atomic Transaction Demo");
    console.log("===============================================================================\n");

    const [deployer, seller, buyer] = await ethers.getSigners();
    console.log(`Deployer Address: ${deployer.address}`);
    console.log(`Seller Address:   ${seller.address}`);
    console.log(`Buyer Address:    ${buyer.address}\n`);

    // 1. Deploy Contracts
    console.log("--- [Step 1] Deploying Smart Contracts ---");
    const Verifier = await ethers.getContractFactory("Groth16Verifier");
    const verifier = await Verifier.deploy();
    await verifier.waitForDeployment();
    console.log(`[✔] Groth16Verifier deployed at:   ${await verifier.getAddress()}`);

    const Marketplace = await ethers.getContractFactory("ZkNFTMarketplace");
    const marketplace = await Marketplace.deploy(await verifier.getAddress(), deployer.address);
    await marketplace.waitForDeployment();
    console.log(`[✔] ZkNFTMarketplace deployed at: ${await marketplace.getAddress()}`);

    const MockNFT = await ethers.getContractFactory("MockERC721");
    const mockNft = await MockNFT.deploy("PrivateArt", "PART", deployer.address);
    await mockNft.waitForDeployment();
    console.log(`[✔] MockERC721 deployed at:       ${await mockNft.getAddress()}\n`);

    // 2. Mint NFT and Approve Marketplace
    const tokenId = 777n;
    const tokenPrice = ethers.parseEther("0.2"); // 0.2 ETH
    const buyerInitialDeposit = ethers.parseEther("1.0"); // 1.0 ETH

    console.log(`--- [Step 2] Minting NFT #${tokenId} to Seller ---`);
    await mockNft.connect(deployer).mintWithId(seller.address, tokenId, "ipfs://qm-cyber-punk-777");
    console.log(`[✔] Token #${tokenId} minted to seller: ${await mockNft.ownerOf(tokenId)}`);

    await mockNft.connect(seller).setApprovalForAll(await marketplace.getAddress(), true);
    console.log(`[✔] Seller approved marketplace for token transfers.\n`);

    // 3. Cryptographic Setup & Commitments
    console.log("--- [Step 3] Cryptographic Secret Generation & Off-Chain Commitments ---");
    const sellerSecretSalt = randomFieldElement().toString();
    const buyerBalanceSalt = randomFieldElement().toString();
    const newNftSalt = randomFieldElement().toString();
    const newBuyerBalanceSalt = randomFieldElement().toString();

    console.log(`Seller Private Salt:    ${sellerSecretSalt.slice(0, 16)}...`);
    console.log(`Buyer Balance Salt:     ${buyerBalanceSalt.slice(0, 16)}...`);

    const proofResult = await generateProofData({
        sellerAddress: seller.address,
        buyerAddress: buyer.address,
        nftId: tokenId.toString(),
        transactionPrice: tokenPrice.toString(),
        buyerBalance: buyerInitialDeposit.toString(),
        sellerSecretSalt,
        buyerBalanceSalt,
        newNftSalt,
        newBuyerBalanceSalt
    });

    console.log(`[✔] Current NFT Commitment:     ${proofResult.tradeDetails.currentNftCommitment}`);
    console.log(`[✔] Current Buyer Balance Comm: ${proofResult.tradeDetails.currentBuyerBalanceCommitment}\n`);

    // 4. On-chain Commitment Registration & Escrow Deposit
    console.log("--- [Step 4] On-Chain Commitment Registration & Buyer Escrow Deposit ---");
    await marketplace.connect(seller).registerNftCommitment(
        await mockNft.getAddress(),
        tokenId,
        proofResult.tradeDetails.currentNftCommitment
    );
    console.log(`[✔] Seller registered NFT commitment on-chain.`);

    await marketplace.connect(buyer).depositConfidentialFunds(
        proofResult.tradeDetails.currentBuyerBalanceCommitment,
        { value: buyerInitialDeposit }
    );
    console.log(`[✔] Buyer deposited 1.0 ETH into confidential escrow.\n`);

    // 5. Generate Proof and Format Solidity Calldata
    console.log("--- [Step 5] Preparing ZK-SNARK Calldata ---");
    const rawCalldata = await snarkjs.groth16.exportSolidityCallData(
        proofResult.proof,
        proofResult.publicSignals
    );
    const formatted = formatSolidityCalldata(rawCalldata);
    console.log(`[✔] Calldata successfully extracted (${formatted.pubSignals.length} public signals).\n`);

    // 6. Execute ZK-SNARK Verified Atomic Trade
    console.log("--- [Step 6] Executing On-Chain ZK-SNARK Atomic Settlement ---");
    const sellerBalBefore = await ethers.provider.getBalance(seller.address);

    const tx = await marketplace.executeZkTrade(
        await mockNft.getAddress(),
        {
            a: formatted.a,
            b: formatted.b,
            c: formatted.c,
            pubSignals: formatted.pubSignals
        }
    );
    const receipt = await tx.wait();
    console.log(`[✔] Transaction mined! Gas used: ${receipt.gasUsed.toString()}`);

    const sellerBalAfter = await ethers.provider.getBalance(seller.address);
    const buyerEscrowRemaining = await marketplace.escrowBalances(buyer.address);
    const finalOwner = await mockNft.ownerOf(tokenId);
    const newNftComm = await marketplace.nftCommitments(await mockNft.getAddress(), tokenId);

    console.log("\n===============================================================================");
    console.log("  TRANSACTION SETTLED SUCCESSFULLY");
    console.log("===============================================================================");
    console.log(`- Final NFT Owner:                 ${finalOwner} (Expected Buyer: ${buyer.address})`);
    console.log(`- Seller Proceeds Received:        ${ethers.formatEther(sellerBalAfter - sellerBalBefore)} ETH`);
    console.log(`- Buyer Remaining Escrow:          ${ethers.formatEther(buyerEscrowRemaining)} ETH`);
    console.log(`- Updated NFT Commitment on-chain: ${newNftComm}`);
    console.log("===============================================================================\n");
}

main().catch((err) => {
    console.error("Demo failed:", err);
    process.exit(1);
});

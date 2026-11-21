const fs = require("fs");
const path = require("path");
const snarkjs = require("snarkjs");
const { hash3, addressToField, randomFieldElement } = require("./zk_utils");

async function generateProofData(customParams = {}) {
    const rootDir = path.resolve(__dirname, "..");
    const wasmPath = path.join(rootDir, "build/circuits/nft_marketplace_js/nft_marketplace.wasm");
    const zkeyPath = path.join(rootDir, "build/circuits/nft_marketplace_final.zkey");

    if (!fs.existsSync(wasmPath) || !fs.existsSync(zkeyPath)) {
        throw new Error("Wasm or zkey not found! Please run 'npm run setup:circuits' first.");
    }

    // Default sample trade parties and parameters
    const sellerAddressHex = customParams.sellerAddress || "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const buyerAddressHex = customParams.buyerAddress || "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
    const nftId = customParams.nftId !== undefined ? BigInt(customParams.nftId).toString() : "42";
    const transactionPrice = customParams.transactionPrice !== undefined ? BigInt(customParams.transactionPrice).toString() : "100000000000000000"; // 0.1 ETH in wei
    const buyerBalance = customParams.buyerBalance !== undefined ? BigInt(customParams.buyerBalance).toString() : "500000000000000000"; // 0.5 ETH in wei

    const sellerAddressField = addressToField(sellerAddressHex);
    const buyerAddressField = addressToField(buyerAddressHex);

    // Private secrets / salts
    const sellerSecretSalt = (customParams.sellerSecretSalt || randomFieldElement()).toString();
    const buyerBalanceSalt = (customParams.buyerBalanceSalt || randomFieldElement()).toString();
    const newNftSalt = (customParams.newNftSalt || randomFieldElement()).toString();
    const newBuyerBalanceSalt = (customParams.newBuyerBalanceSalt || randomFieldElement()).toString();

    // Derived values
    const newBuyerBalance = (BigInt(buyerBalance) - BigInt(transactionPrice)).toString();

    // Commitments
    // 1. Current NFT Commitment: Poseidon(nftId, sellerAddress, sellerSecretSalt)
    const currentNftCommitment = await hash3(nftId, sellerAddressField, sellerSecretSalt);

    // 2. Current Buyer Balance Commitment: Poseidon(buyerAddress, buyerBalance, buyerBalanceSalt)
    const currentBuyerBalanceCommitment = await hash3(buyerAddressField, buyerBalance, buyerBalanceSalt);

    // 3. New NFT Commitment: Poseidon(nftId, buyerAddress, newNftSalt)
    const newNftCommitment = await hash3(nftId, buyerAddressField, newNftSalt);

    // 4. New Buyer Balance Commitment: Poseidon(buyerAddress, newBuyerBalance, newBuyerBalanceSalt)
    const newBuyerBalanceCommitment = await hash3(buyerAddressField, newBuyerBalance, newBuyerBalanceSalt);

    const circuitInput = {
        // Public inputs
        currentNftCommitment,
        currentBuyerBalanceCommitment,
        newNftCommitment,
        newBuyerBalanceCommitment,
        nftId,
        transactionPrice,
        sellerAddress: sellerAddressField,
        buyerAddress: buyerAddressField,

        // Private inputs
        sellerSecretSalt,
        buyerBalance,
        buyerBalanceSalt,
        newNftSalt,
        newBuyerBalanceSalt
    };

    console.log("Generating witness and ZK-SNARK proof using snarkjs Groth16...");
    const startTime = Date.now();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        circuitInput,
        wasmPath,
        zkeyPath
    );
    const duration = Date.now() - startTime;
    console.log(`Proof successfully generated in ${duration} ms!`);

    return {
        circuitInput,
        proof,
        publicSignals,
        tradeDetails: {
            nftId,
            transactionPrice,
            sellerAddress: sellerAddressHex,
            buyerAddress: buyerAddressHex,
            sellerAddressField,
            buyerAddressField,
            currentNftCommitment,
            currentBuyerBalanceCommitment,
            newNftCommitment,
            newBuyerBalanceCommitment,
            sellerSecretSalt,
            buyerBalance,
            buyerBalanceSalt,
            newNftSalt,
            newBuyerBalanceSalt,
            newBuyerBalance
        }
    };
}

// Convert snarkjs calldata into formatted Solidity function parameters
function formatSolidityCalldata(solidityCallDataStr) {
    const argv = solidityCallDataStr
        .replace(/["[\]\s]/g, "")
        .split(",")
        .map((x) => BigInt(x).toString());

    const a = [argv[0], argv[1]];
    const b = [
        [argv[2], argv[3]],
        [argv[4], argv[5]]
    ];
    const c = [argv[6], argv[7]];
    const pubSignals = argv.slice(8);

    return { a, b, c, pubSignals };
}

async function main() {
    const outputDir = path.resolve(__dirname, "../build/proof");
    fs.mkdirSync(outputDir, { recursive: true });

    const result = await generateProofData();

    fs.writeFileSync(path.join(outputDir, "input.json"), JSON.stringify(result.circuitInput, null, 2));
    fs.writeFileSync(path.join(outputDir, "proof.json"), JSON.stringify(result.proof, null, 2));
    fs.writeFileSync(path.join(outputDir, "public.json"), JSON.stringify(result.publicSignals, null, 2));
    fs.writeFileSync(path.join(outputDir, "tradeDetails.json"), JSON.stringify(result.tradeDetails, null, 2));

    const rawCalldata = await snarkjs.groth16.exportSolidityCallData(result.proof, result.publicSignals);
    const formatted = formatSolidityCalldata(rawCalldata);
    fs.writeFileSync(path.join(outputDir, "solidityCalldata.json"), JSON.stringify(formatted, null, 2));

    console.log("\nProof generation summary:");
    console.log("------------------------");
    console.log("NFT ID:                       ", result.tradeDetails.nftId);
    console.log("Transaction Price:            ", result.tradeDetails.transactionPrice, "wei");
    console.log("Current NFT Commitment:       ", result.tradeDetails.currentNftCommitment);
    console.log("Current Buyer Balance Comm:   ", result.tradeDetails.currentBuyerBalanceCommitment);
    console.log("New NFT Commitment:           ", result.tradeDetails.newNftCommitment);
    console.log("New Buyer Balance Comm:       ", result.tradeDetails.newBuyerBalanceCommitment);
    console.log("Public Signals Count:         ", result.publicSignals.length);
    console.log("\nArtifacts saved in build/proof/: input.json, proof.json, public.json, solidityCalldata.json");
    process.exit(0);
}

if (require.main === module) {
    main().catch((err) => {
        console.error("Error generating proof:", err);
        process.exit(1);
    });
}

module.exports = {
    generateProofData,
    formatSolidityCalldata
};

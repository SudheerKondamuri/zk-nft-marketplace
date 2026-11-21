const fs = require("fs");
const path = require("path");
const snarkjs = require("snarkjs");

async function verifyProof(vKeyPath, publicSignalsPath, proofPath) {
    const rootDir = path.resolve(__dirname, "..");
    const vKey = JSON.parse(fs.readFileSync(vKeyPath || path.join(rootDir, "build/circuits/verification_key.json"), "utf8"));
    const publicSignals = JSON.parse(fs.readFileSync(publicSignalsPath || path.join(rootDir, "build/proof/public.json"), "utf8"));
    const proof = JSON.parse(fs.readFileSync(proofPath || path.join(rootDir, "build/proof/proof.json"), "utf8"));

    console.log("Verifying ZK-SNARK Groth16 proof with snarkjs...");
    const isValid = await snarkjs.groth16.verify(vKey, publicSignals, proof);

    if (isValid) {
        console.log("SUCCESS: The ZK-SNARK proof is cryptographically VALID!");
        console.log("Verified Properties:");
        console.log("  1. Seller owns the NFT (Commitment verified).");
        console.log("  2. Buyer has sufficient funds (Solvency inequality verified).");
        console.log("  3. Transaction price is correct and balance updated accurately.");
        console.log("  4. NFT ownership is legitimately transferred to buyer.");
    } else {
        console.error("FAILURE: The proof is INVALID!");
    }

    return isValid;
}

async function main() {
    const proofDir = path.resolve(__dirname, "../build/proof");
    const proofPath = path.join(proofDir, "proof.json");

    if (!fs.existsSync(proofPath)) {
        console.log("Proof not found. Generating sample proof first...");
        const { generateProofData } = require("./generate_proof");
        await generateProofData();
    }

    const isValid = await verifyProof();
    process.exit(isValid ? 0 : 1);
}

if (require.main === module) {
    main().catch((err) => {
        console.error("Error during verification:", err);
        process.exit(1);
    });
}

module.exports = {
    verifyProof
};

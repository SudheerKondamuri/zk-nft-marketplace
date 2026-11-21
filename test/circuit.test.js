const { expect } = require("chai");
const path = require("path");
const fs = require("fs");
const snarkjs = require("snarkjs");
const { hash3, addressToField, randomFieldElement } = require("../scripts/zk_utils");

describe("Circom Circuit: NftMarketplaceTransaction", function () {
    this.timeout(120000);

    const rootDir = path.resolve(__dirname, "..");
    const wasmPath = path.join(rootDir, "build/circuits/nft_marketplace_js/nft_marketplace.wasm");
    const zkeyPath = path.join(rootDir, "build/circuits/nft_marketplace_final.zkey");
    const vKeyPath = path.join(rootDir, "build/circuits/verification_key.json");

    let vKey;
    const sellerAddressHex = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const buyerAddressHex = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
    const sellerAddressField = addressToField(sellerAddressHex);
    const buyerAddressField = addressToField(buyerAddressHex);
    const nftId = "101";
    const transactionPrice = "100000000000000000"; // 0.1 ETH
    const buyerBalance = "500000000000000000";     // 0.5 ETH

    before(async function () {
        expect(fs.existsSync(wasmPath), "WASM file should exist").to.be.true;
        expect(fs.existsSync(zkeyPath), "ZKEY file should exist").to.be.true;
        expect(fs.existsSync(vKeyPath), "Verification key should exist").to.be.true;
        vKey = JSON.parse(fs.readFileSync(vKeyPath, "utf8"));
    });

    it("should successfully generate and verify a proof for a valid transaction", async function () {
        const sellerSecretSalt = randomFieldElement().toString();
        const buyerBalanceSalt = randomFieldElement().toString();
        const newNftSalt = randomFieldElement().toString();
        const newBuyerBalanceSalt = randomFieldElement().toString();

        const newBuyerBalance = (BigInt(buyerBalance) - BigInt(transactionPrice)).toString();

        const currentNftCommitment = await hash3(nftId, sellerAddressField, sellerSecretSalt);
        const currentBuyerBalanceCommitment = await hash3(buyerAddressField, buyerBalance, buyerBalanceSalt);
        const newNftCommitment = await hash3(nftId, buyerAddressField, newNftSalt);
        const newBuyerBalanceCommitment = await hash3(buyerAddressField, newBuyerBalance, newBuyerBalanceSalt);

        const circuitInput = {
            currentNftCommitment,
            currentBuyerBalanceCommitment,
            newNftCommitment,
            newBuyerBalanceCommitment,
            nftId,
            transactionPrice,
            sellerAddress: sellerAddressField,
            buyerAddress: buyerAddressField,
            sellerSecretSalt,
            buyerBalance,
            buyerBalanceSalt,
            newNftSalt,
            newBuyerBalanceSalt
        };

        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
            circuitInput,
            wasmPath,
            zkeyPath
        );

        expect(proof).to.not.be.undefined;
        expect(publicSignals).to.have.lengthOf(8);

        // Verify with snarkjs
        const isValid = await snarkjs.groth16.verify(vKey, publicSignals, proof);
        expect(isValid).to.be.true;
    });

    it("should fail constraint check if buyer balance is insufficient (buyerBalance < price)", async function () {
        const sellerSecretSalt = randomFieldElement().toString();
        const buyerBalanceSalt = randomFieldElement().toString();
        const newNftSalt = randomFieldElement().toString();
        const newBuyerBalanceSalt = randomFieldElement().toString();

        const lowBuyerBalance = "50000000000000000"; // 0.05 ETH < 0.1 ETH
        // Trying to forge new balance
        const newBuyerBalance = "0";

        const currentNftCommitment = await hash3(nftId, sellerAddressField, sellerSecretSalt);
        const currentBuyerBalanceCommitment = await hash3(buyerAddressField, lowBuyerBalance, buyerBalanceSalt);
        const newNftCommitment = await hash3(nftId, buyerAddressField, newNftSalt);
        const newBuyerBalanceCommitment = await hash3(buyerAddressField, newBuyerBalance, newBuyerBalanceSalt);

        const circuitInput = {
            currentNftCommitment,
            currentBuyerBalanceCommitment,
            newNftCommitment,
            newBuyerBalanceCommitment,
            nftId,
            transactionPrice,
            sellerAddress: sellerAddressField,
            buyerAddress: buyerAddressField,
            sellerSecretSalt,
            buyerBalance: lowBuyerBalance,
            buyerBalanceSalt,
            newNftSalt,
            newBuyerBalanceSalt
        };

        let failed = false;
        try {
            await snarkjs.groth16.fullProve(circuitInput, wasmPath, zkeyPath);
        } catch (err) {
            failed = true;
        }
        expect(failed, "Proof generation should fail when buyer balance is insufficient").to.be.true;
    });

    it("should fail constraint check if seller does not know the secret salt for the NFT", async function () {
        const correctSellerSecretSalt = randomFieldElement().toString();
        const wrongSellerSecretSalt = randomFieldElement().toString();
        const buyerBalanceSalt = randomFieldElement().toString();
        const newNftSalt = randomFieldElement().toString();
        const newBuyerBalanceSalt = randomFieldElement().toString();

        const newBuyerBalance = (BigInt(buyerBalance) - BigInt(transactionPrice)).toString();

        // Commitment was registered with correct salt
        const currentNftCommitment = await hash3(nftId, sellerAddressField, correctSellerSecretSalt);
        const currentBuyerBalanceCommitment = await hash3(buyerAddressField, buyerBalance, buyerBalanceSalt);
        const newNftCommitment = await hash3(nftId, buyerAddressField, newNftSalt);
        const newBuyerBalanceCommitment = await hash3(buyerAddressField, newBuyerBalance, newBuyerBalanceSalt);

        // Attacker attempts to provide wrong sellerSecretSalt
        const circuitInput = {
            currentNftCommitment,
            currentBuyerBalanceCommitment,
            newNftCommitment,
            newBuyerBalanceCommitment,
            nftId,
            transactionPrice,
            sellerAddress: sellerAddressField,
            buyerAddress: buyerAddressField,
            sellerSecretSalt: wrongSellerSecretSalt,
            buyerBalance,
            buyerBalanceSalt,
            newNftSalt,
            newBuyerBalanceSalt
        };

        let failed = false;
        try {
            await snarkjs.groth16.fullProve(circuitInput, wasmPath, zkeyPath);
        } catch (err) {
            failed = true;
        }
        expect(failed, "Proof generation should fail when seller secret salt is incorrect").to.be.true;
    });

    it("should fail constraint check if updated balance is computed incorrectly", async function () {
        const sellerSecretSalt = randomFieldElement().toString();
        const buyerBalanceSalt = randomFieldElement().toString();
        const newNftSalt = randomFieldElement().toString();
        const newBuyerBalanceSalt = randomFieldElement().toString();

        // Pretend buyer kept full balance without subtracting price
        const fraudulentNewBalance = buyerBalance;

        const currentNftCommitment = await hash3(nftId, sellerAddressField, sellerSecretSalt);
        const currentBuyerBalanceCommitment = await hash3(buyerAddressField, buyerBalance, buyerBalanceSalt);
        const newNftCommitment = await hash3(nftId, buyerAddressField, newNftSalt);
        const fraudulentNewBuyerBalanceCommitment = await hash3(buyerAddressField, fraudulentNewBalance, newBuyerBalanceSalt);

        const circuitInput = {
            currentNftCommitment,
            currentBuyerBalanceCommitment,
            newNftCommitment,
            newBuyerBalanceCommitment: fraudulentNewBuyerBalanceCommitment,
            nftId,
            transactionPrice,
            sellerAddress: sellerAddressField,
            buyerAddress: buyerAddressField,
            sellerSecretSalt,
            buyerBalance,
            buyerBalanceSalt,
            newNftSalt,
            newBuyerBalanceSalt
        };

        let failed = false;
        try {
            await snarkjs.groth16.fullProve(circuitInput, wasmPath, zkeyPath);
        } catch (err) {
            failed = true;
        }
        expect(failed, "Proof generation should fail when balance update is incorrect").to.be.true;
    });
});

pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

/*
    NftMarketplaceTransaction Circuit
    ---------------------------------
    Verifies the validity of an NFT marketplace transaction with Zero Knowledge:
    1. Seller owns the NFT:
       currentNftCommitment == Poseidon([nftId, sellerAddress, sellerSecretSalt])
    2. Buyer has sufficient funds without revealing buyer's exact balance:
       currentBuyerBalanceCommitment == Poseidon([buyerAddress, buyerBalance, buyerBalanceSalt])
       buyerBalance >= transactionPrice (using GreaterEqThan(64))
    3. Transaction price is correct and updates buyer's balance:
       newBuyerBalance == buyerBalance - transactionPrice
       newBuyerBalanceCommitment == Poseidon([buyerAddress, newBuyerBalance, newBuyerBalanceSalt])
    4. NFT ownership is transferred correctly to buyer:
       newNftCommitment == Poseidon([nftId, buyerAddress, newNftSalt])
*/
template NftMarketplaceTransaction() {
    // ----------------------------------------------------
    // Public Inputs (known to both parties and verified on-chain)
    // ----------------------------------------------------
    signal input currentNftCommitment;
    signal input currentBuyerBalanceCommitment;
    signal input newNftCommitment;
    signal input newBuyerBalanceCommitment;
    signal input nftId;
    signal input transactionPrice;
    signal input sellerAddress;
    signal input buyerAddress;

    // ----------------------------------------------------
    // Private Inputs (confidential witness signals)
    // ----------------------------------------------------
    signal input sellerSecretSalt;
    signal input buyerBalance;
    signal input buyerBalanceSalt;
    signal input newNftSalt;
    signal input newBuyerBalanceSalt;

    // ----------------------------------------------------
    // 1. Verify Seller owns the NFT
    // ----------------------------------------------------
    component sellerNftHasher = Poseidon(3);
    sellerNftHasher.inputs[0] <== nftId;
    sellerNftHasher.inputs[1] <== sellerAddress;
    sellerNftHasher.inputs[2] <== sellerSecretSalt;
    sellerNftHasher.out === currentNftCommitment;

    // ----------------------------------------------------
    // 2. Verify Buyer Balance Commitment
    // ----------------------------------------------------
    component buyerBalanceHasher = Poseidon(3);
    buyerBalanceHasher.inputs[0] <== buyerAddress;
    buyerBalanceHasher.inputs[1] <== buyerBalance;
    buyerBalanceHasher.inputs[2] <== buyerBalanceSalt;
    buyerBalanceHasher.out === currentBuyerBalanceCommitment;

    // ----------------------------------------------------
    // 3. Verify Buyer has Sufficient Funds (buyerBalance >= transactionPrice)
    // ----------------------------------------------------
    component sufficientFunds = GreaterEqThan(64);
    sufficientFunds.in[0] <== buyerBalance;
    sufficientFunds.in[1] <== transactionPrice;
    sufficientFunds.out === 1;

    // ----------------------------------------------------
    // 4. Verify Transaction Price and Correct Balance Transition
    // ----------------------------------------------------
    signal newBuyerBalance;
    newBuyerBalance <== buyerBalance - transactionPrice;

    component newBuyerBalanceHasher = Poseidon(3);
    newBuyerBalanceHasher.inputs[0] <== buyerAddress;
    newBuyerBalanceHasher.inputs[1] <== newBuyerBalance;
    newBuyerBalanceHasher.inputs[2] <== newBuyerBalanceSalt;
    newBuyerBalanceHasher.out === newBuyerBalanceCommitment;

    // ----------------------------------------------------
    // 5. Verify NFT Ownership Transferred Correctly to Buyer
    // ----------------------------------------------------
    component newNftHasher = Poseidon(3);
    newNftHasher.inputs[0] <== nftId;
    newNftHasher.inputs[1] <== buyerAddress;
    newNftHasher.inputs[2] <== newNftSalt;
    newNftHasher.out === newNftCommitment;
}

component main {public [
    currentNftCommitment,
    currentBuyerBalanceCommitment,
    newNftCommitment,
    newBuyerBalanceCommitment,
    nftId,
    transactionPrice,
    sellerAddress,
    buyerAddress
]} = NftMarketplaceTransaction();

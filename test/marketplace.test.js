const { expect } = require("chai");
const { ethers } = require("hardhat");
const { generateProofData, formatSolidityCalldata } = require("../scripts/generate_proof");
const { hash3, addressToField, randomFieldElement } = require("../scripts/zk_utils");
const snarkjs = require("snarkjs");

describe("ZkNFTMarketplace End-to-End Suite", function () {
    this.timeout(120000);

    let deployer, seller, buyer, bidder, otherUser;
    let mockNft, verifier, marketplace;

    const TOKEN_PRICE = ethers.parseEther("0.1"); // 0.1 ETH
    const BUYER_DEPOSIT = ethers.parseEther("0.5"); // 0.5 ETH

    beforeEach(async function () {
        [deployer, seller, buyer, bidder, otherUser] = await ethers.getSigners();

        // 1. Deploy Groth16 Verifier
        const VerifierFactory = await ethers.getContractFactory("Groth16Verifier");
        verifier = await VerifierFactory.deploy();
        await verifier.waitForDeployment();

        // 2. Deploy ZkNFTMarketplace
        const MarketplaceFactory = await ethers.getContractFactory("ZkNFTMarketplace");
        marketplace = await MarketplaceFactory.deploy(await verifier.getAddress(), deployer.address);
        await marketplace.waitForDeployment();

        // 3. Deploy MockERC721
        const NftFactory = await ethers.getContractFactory("MockERC721");
        mockNft = await NftFactory.deploy("MarketplaceNFT", "MNFT", deployer.address);
        await mockNft.waitForDeployment();
    });

    describe("1. Standard NFT Marketplace Capabilities", function () {
        let tokenId;

        beforeEach(async function () {
            // Mint an NFT to seller
            const tx = await mockNft.connect(deployer).mint(seller.address, "ipfs://token-1");
            const receipt = await tx.wait();
            tokenId = 1n;

            // Seller approves marketplace
            await mockNft.connect(seller).setApprovalForAll(await marketplace.getAddress(), true);
        });

        it("should allow a seller to list an NFT and cancel listing", async function () {
            await expect(marketplace.connect(seller).listItem(await mockNft.getAddress(), tokenId, TOKEN_PRICE))
                .to.emit(marketplace, "ItemListed")
                .withArgs(await mockNft.getAddress(), tokenId, seller.address, TOKEN_PRICE);

            const listing = await marketplace.listings(await mockNft.getAddress(), tokenId);
            expect(listing.seller).to.equal(seller.address);
            expect(listing.price).to.equal(TOKEN_PRICE);
            expect(listing.isActive).to.be.true;

            // Cancel listing
            await expect(marketplace.connect(seller).cancelListing(await mockNft.getAddress(), tokenId))
                .to.emit(marketplace, "ListingCancelled")
                .withArgs(await mockNft.getAddress(), tokenId, seller.address);

            const cancelledListing = await marketplace.listings(await mockNft.getAddress(), tokenId);
            expect(cancelledListing.isActive).to.be.false;
        });

        it("should allow a buyer to directly purchase a listed NFT", async function () {
            await marketplace.connect(seller).listItem(await mockNft.getAddress(), tokenId, TOKEN_PRICE);

            const sellerInitialBalance = await ethers.provider.getBalance(seller.address);

            // Buyer buys item
            await expect(
                marketplace.connect(buyer).buyItem(await mockNft.getAddress(), tokenId, { value: TOKEN_PRICE })
            )
                .to.emit(marketplace, "ItemBought")
                .withArgs(await mockNft.getAddress(), tokenId, seller.address, buyer.address, TOKEN_PRICE);

            // Ownership transferred to buyer
            expect(await mockNft.ownerOf(tokenId)).to.equal(buyer.address);

            // Seller received payment
            const sellerFinalBalance = await ethers.provider.getBalance(seller.address);
            expect(sellerFinalBalance - sellerInitialBalance).to.equal(TOKEN_PRICE);
        });

        it("should support bidding: create bid, outbid, cancel bid, and accept bid", async function () {
            const bidAmount1 = ethers.parseEther("0.05");
            const bidAmount2 = ethers.parseEther("0.08");

            // Bidder places first bid
            await expect(
                marketplace.connect(bidder).createBid(await mockNft.getAddress(), tokenId, { value: bidAmount1 })
            )
                .to.emit(marketplace, "BidCreated")
                .withArgs(await mockNft.getAddress(), tokenId, bidder.address, bidAmount1);

            expect(await marketplace.highestBidder(await mockNft.getAddress(), tokenId)).to.equal(bidder.address);

            // Other user places a higher bid
            await expect(
                marketplace.connect(otherUser).createBid(await mockNft.getAddress(), tokenId, { value: bidAmount2 })
            )
                .to.emit(marketplace, "BidCreated")
                .withArgs(await mockNft.getAddress(), tokenId, otherUser.address, bidAmount2);

            expect(await marketplace.highestBidder(await mockNft.getAddress(), tokenId)).to.equal(otherUser.address);

            // Bidder cancels their lower bid and gets refunded
            const bidderInitialBalance = await ethers.provider.getBalance(bidder.address);
            const cancelTx = await marketplace.connect(bidder).cancelBid(await mockNft.getAddress(), tokenId);
            const cancelReceipt = await cancelTx.wait();
            const gasUsed = cancelReceipt.gasUsed * cancelReceipt.gasPrice;

            const bidderFinalBalance = await ethers.provider.getBalance(bidder.address);
            expect(bidderFinalBalance + gasUsed - bidderInitialBalance).to.equal(bidAmount1);

            // Seller accepts the highest bid from otherUser
            const sellerInitialBalance = await ethers.provider.getBalance(seller.address);
            await expect(
                marketplace.connect(seller).acceptBid(await mockNft.getAddress(), tokenId, otherUser.address)
            )
                .to.emit(marketplace, "BidAccepted")
                .withArgs(await mockNft.getAddress(), tokenId, seller.address, otherUser.address, bidAmount2);

            // NFT now belongs to otherUser
            expect(await mockNft.ownerOf(tokenId)).to.equal(otherUser.address);

            // Seller received bid amount
            const sellerFinalBalance = await ethers.provider.getBalance(seller.address);
            expect(sellerFinalBalance - sellerInitialBalance).to.be.closeTo(bidAmount2, ethers.parseEther("0.001"));
        });
    });

    describe("2. Zero-Knowledge Confidential Marketplace Settlement", function () {
        let zkTokenId;
        let sellerSecretSalt;
        let buyerBalanceSalt;
        let newNftSalt;
        let newBuyerBalanceSalt;
        let proofResult;

        beforeEach(async function () {
            zkTokenId = 42n;

            // Mint NFT #42 to seller
            await mockNft.connect(deployer).mintWithId(seller.address, zkTokenId, "ipfs://confidential-42");
            await mockNft.connect(seller).setApprovalForAll(await marketplace.getAddress(), true);

            // Generate cryptographic secrets and salts
            sellerSecretSalt = randomFieldElement().toString();
            buyerBalanceSalt = randomFieldElement().toString();
            newNftSalt = randomFieldElement().toString();
            newBuyerBalanceSalt = randomFieldElement().toString();

            // Generate genuine ZK-SNARK proof using snarkjs Groth16
            proofResult = await generateProofData({
                sellerAddress: seller.address,
                buyerAddress: buyer.address,
                nftId: zkTokenId.toString(),
                transactionPrice: TOKEN_PRICE.toString(),
                buyerBalance: BUYER_DEPOSIT.toString(),
                sellerSecretSalt,
                buyerBalanceSalt,
                newNftSalt,
                newBuyerBalanceSalt
            });

            // 1. Seller registers confidential NFT commitment on-chain
            await marketplace.connect(seller).registerNftCommitment(
                await mockNft.getAddress(),
                zkTokenId,
                proofResult.tradeDetails.currentNftCommitment
            );

            // 2. Buyer deposits funds into confidential escrow on-chain
            await marketplace.connect(buyer).depositConfidentialFunds(
                proofResult.tradeDetails.currentBuyerBalanceCommitment,
                { value: BUYER_DEPOSIT }
            );
        });

        it("should execute confidential trade atomically via ZK-SNARK verification", async function () {
            const rawCalldata = await snarkjs.groth16.exportSolidityCallData(
                proofResult.proof,
                proofResult.publicSignals
            );
            const formatted = formatSolidityCalldata(rawCalldata);

            const sellerInitialBalance = await ethers.provider.getBalance(seller.address);

            // Execute ZK-SNARK trade on the smart contract
            const tx = await marketplace.executeZkTrade(
                await mockNft.getAddress(),
                {
                    a: formatted.a,
                    b: formatted.b,
                    c: formatted.c,
                    pubSignals: formatted.pubSignals
                }
            );

            await expect(tx)
                .to.emit(marketplace, "ZkTradeSettled")
                .withArgs(
                    await mockNft.getAddress(),
                    zkTokenId,
                    seller.address,
                    buyer.address,
                    TOKEN_PRICE,
                    proofResult.tradeDetails.newNftCommitment
                );

            // Assert 1: NFT transferred to buyer
            expect(await mockNft.ownerOf(zkTokenId)).to.equal(buyer.address);

            // Assert 2: Seller received payment
            const sellerFinalBalance = await ethers.provider.getBalance(seller.address);
            expect(sellerFinalBalance - sellerInitialBalance).to.equal(TOKEN_PRICE);

            // Assert 3: Buyer's on-chain escrow balance decreased by transaction price
            const remainingEscrow = await marketplace.escrowBalances(buyer.address);
            expect(remainingEscrow).to.equal(BUYER_DEPOSIT - TOKEN_PRICE);

            // Assert 4: On-chain commitments updated to new state
            expect(await marketplace.nftCommitments(await mockNft.getAddress(), zkTokenId))
                .to.equal(proofResult.tradeDetails.newNftCommitment);
            expect(await marketplace.buyerBalanceCommitments(buyer.address))
                .to.equal(proofResult.tradeDetails.newBuyerBalanceCommitment);
        });

        it("should revert if an invalid or tampered ZK-SNARK proof is supplied", async function () {
            const rawCalldata = await snarkjs.groth16.exportSolidityCallData(
                proofResult.proof,
                proofResult.publicSignals
            );
            const formatted = formatSolidityCalldata(rawCalldata);

            // Tamper with proof parameter a[0]
            const tamperedA = [
                (BigInt(formatted.a[0]) + 1n).toString(),
                formatted.a[1]
            ];

            await expect(
                marketplace.executeZkTrade(await mockNft.getAddress(), {
                    a: tamperedA,
                    b: formatted.b,
                    c: formatted.c,
                    pubSignals: formatted.pubSignals
                })
            ).to.be.revertedWith("Invalid ZK-SNARK proof");
        });

        it("should revert if public signals do not match registered on-chain NFT commitment", async function () {
            const rawCalldata = await snarkjs.groth16.exportSolidityCallData(
                proofResult.proof,
                proofResult.publicSignals
            );
            const formatted = formatSolidityCalldata(rawCalldata);

            // Overwrite on-chain commitment with a different one
            await marketplace.connect(seller).registerNftCommitment(
                await mockNft.getAddress(),
                zkTokenId,
                123456789n
            );

            await expect(
                marketplace.executeZkTrade(await mockNft.getAddress(), {
                    a: formatted.a,
                    b: formatted.b,
                    c: formatted.c,
                    pubSignals: formatted.pubSignals
                })
            ).to.be.revertedWith("Mismatched NFT commitment");
        });

        it("should revert if public signals do not match buyer registered balance commitment", async function () {
            const rawCalldata = await snarkjs.groth16.exportSolidityCallData(
                proofResult.proof,
                proofResult.publicSignals
            );
            const formatted = formatSolidityCalldata(rawCalldata);

            // Modify buyer balance commitment on-chain
            await marketplace.connect(buyer).depositConfidentialFunds(
                999999999n,
                { value: ethers.parseEther("0.1") }
            );

            await expect(
                marketplace.executeZkTrade(await mockNft.getAddress(), {
                    a: formatted.a,
                    b: formatted.b,
                    c: formatted.c,
                    pubSignals: formatted.pubSignals
                })
            ).to.be.revertedWith("Mismatched buyer balance commitment");
        });
    });
});

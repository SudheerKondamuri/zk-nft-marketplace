// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IGroth16Verifier {
    function verifyProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[8] calldata _pubSignals
    ) external view returns (bool);
}

/**
 * @title ZkNFTMarketplace
 * @notice Simplified NFT Marketplace supporting:
 *         1. Standard listing, buying, and bidding functions.
 *         2. Zero-Knowledge confidential transaction verification & atomic settlement.
 */
contract ZkNFTMarketplace is ReentrancyGuard, Ownable {
    // ----------------------------------------------------
    // Types & Structs
    // ----------------------------------------------------
    struct Listing {
        address seller;
        uint256 price;
        bool isActive;
    }

    struct Bid {
        address bidder;
        uint256 amount;
        bool isActive;
    }

    struct ZkTradeProof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
        uint256[8] pubSignals;
    }

    // ----------------------------------------------------
    // State Variables
    // ----------------------------------------------------
    IGroth16Verifier public verifier;

    // Standard marketplace mappings: nftContract => tokenId => Listing
    mapping(address => mapping(uint256 => Listing)) public listings;

    // Bids mapping: nftContract => tokenId => bidder => Bid
    mapping(address => mapping(uint256 => mapping(address => Bid))) public bids;

    // Highest bid mapping: nftContract => tokenId => address of highest bidder
    mapping(address => mapping(uint256 => address)) public highestBidder;

    // Zero-Knowledge Confidential State
    // nftContract => tokenId => confidential NFT ownership commitment
    mapping(address => mapping(uint256 => uint256)) public nftCommitments;

    // User address => confidential balance commitment
    mapping(address => uint256) public buyerBalanceCommitments;

    // User address => deposited escrow balance in ETH (wei)
    mapping(address => uint256) public escrowBalances;

    // ----------------------------------------------------
    // Events
    // ----------------------------------------------------
    event ItemListed(address indexed nftContract, uint256 indexed tokenId, address indexed seller, uint256 price);
    event ListingCancelled(address indexed nftContract, uint256 indexed tokenId, address indexed seller);
    event ItemBought(address indexed nftContract, uint256 indexed tokenId, address indexed seller, address buyer, uint256 price);

    event BidCreated(address indexed nftContract, uint256 indexed tokenId, address indexed bidder, uint256 amount);
    event BidCancelled(address indexed nftContract, uint256 indexed tokenId, address indexed bidder, uint256 amount);
    event BidAccepted(address indexed nftContract, uint256 indexed tokenId, address indexed seller, address bidder, uint256 amount);

    event NftCommitmentRegistered(address indexed nftContract, uint256 indexed tokenId, address indexed owner, uint256 commitment);
    event ConfidentialDeposit(address indexed user, uint256 amount, uint256 balanceCommitment);
    event ConfidentialWithdrawal(address indexed user, uint256 amount, uint256 newBalanceCommitment);
    event ZkTradeSettled(
        address indexed nftContract,
        uint256 indexed tokenId,
        address indexed seller,
        address buyer,
        uint256 price,
        uint256 newNftCommitment
    );

    // ----------------------------------------------------
    // Constructor
    // ----------------------------------------------------
    constructor(address _verifier, address initialOwner) Ownable(initialOwner) {
        verifier = IGroth16Verifier(_verifier);
    }

    function setVerifier(address _verifier) external onlyOwner {
        verifier = IGroth16Verifier(_verifier);
    }

    // ====================================================
    // Standard Marketplace: Listing & Direct Buying
    // ====================================================

    function listItem(address nftContract, uint256 tokenId, uint256 price) external nonReentrant {
        require(price > 0, "Price must be greater than zero");
        IERC721 nft = IERC721(nftContract);
        require(nft.ownerOf(tokenId) == msg.sender, "Caller is not token owner");
        require(
            nft.isApprovedForAll(msg.sender, address(this)) || nft.getApproved(tokenId) == address(this),
            "Marketplace not approved"
        );

        listings[nftContract][tokenId] = Listing({
            seller: msg.sender,
            price: price,
            isActive: true
        });

        emit ItemListed(nftContract, tokenId, msg.sender, price);
    }

    function cancelListing(address nftContract, uint256 tokenId) external nonReentrant {
        Listing storage listing = listings[nftContract][tokenId];
        require(listing.isActive, "Listing not active");
        require(listing.seller == msg.sender, "Caller is not seller");

        listing.isActive = false;
        emit ListingCancelled(nftContract, tokenId, msg.sender);
    }

    function buyItem(address nftContract, uint256 tokenId) external payable nonReentrant {
        Listing storage listing = listings[nftContract][tokenId];
        require(listing.isActive, "Listing not active");
        require(msg.value == listing.price, "Incorrect ETH value sent");

        address seller = listing.seller;
        uint256 price = listing.price;
        listing.isActive = false;

        // Transfer funds to seller
        (bool success, ) = payable(seller).call{value: price}("");
        require(success, "ETH transfer to seller failed");

        // Transfer NFT to buyer
        IERC721(nftContract).safeTransferFrom(seller, msg.sender, tokenId);

        emit ItemBought(nftContract, tokenId, seller, msg.sender, price);
    }

    // ====================================================
    // Standard Marketplace: Bidding
    // ====================================================

    function createBid(address nftContract, uint256 tokenId) external payable nonReentrant {
        require(msg.value > 0, "Bid must be greater than zero");
        Bid storage currentBid = bids[nftContract][tokenId][msg.sender];
        uint256 totalBid = currentBid.amount + msg.value;

        address currentHighest = highestBidder[nftContract][tokenId];
        if (currentHighest != address(0) && currentHighest != msg.sender) {
            uint256 currentHighestAmount = bids[nftContract][tokenId][currentHighest].amount;
            require(totalBid > currentHighestAmount, "Bid not higher than current highest");
        }

        bids[nftContract][tokenId][msg.sender] = Bid({
            bidder: msg.sender,
            amount: totalBid,
            isActive: true
        });
        highestBidder[nftContract][tokenId] = msg.sender;

        emit BidCreated(nftContract, tokenId, msg.sender, totalBid);
    }

    function cancelBid(address nftContract, uint256 tokenId) external nonReentrant {
        Bid storage bid = bids[nftContract][tokenId][msg.sender];
        require(bid.isActive, "No active bid found");
        uint256 amount = bid.amount;

        bid.amount = 0;
        bid.isActive = false;

        if (highestBidder[nftContract][tokenId] == msg.sender) {
            delete highestBidder[nftContract][tokenId];
        }

        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Refund failed");

        emit BidCancelled(nftContract, tokenId, msg.sender, amount);
    }

    function acceptBid(address nftContract, uint256 tokenId, address bidder) external nonReentrant {
        IERC721 nft = IERC721(nftContract);
        require(nft.ownerOf(tokenId) == msg.sender, "Caller is not token owner");

        Bid storage bid = bids[nftContract][tokenId][bidder];
        require(bid.isActive, "Bid is not active");

        uint256 amount = bid.amount;
        bid.amount = 0;
        bid.isActive = false;

        // Clear listing if present
        if (listings[nftContract][tokenId].isActive) {
            listings[nftContract][tokenId].isActive = false;
        }
        if (highestBidder[nftContract][tokenId] == bidder) {
            delete highestBidder[nftContract][tokenId];
        }

        // Pay seller
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Payment to seller failed");

        // Transfer NFT to bidder
        nft.safeTransferFrom(msg.sender, bidder, tokenId);

        emit BidAccepted(nftContract, tokenId, msg.sender, bidder, amount);
    }

    // ====================================================
    // Zero-Knowledge State & Confidential Commitments
    // ====================================================

    /**
     * @notice Register confidential NFT commitment: Poseidon(nftId, owner, salt)
     */
    function registerNftCommitment(address nftContract, uint256 tokenId, uint256 commitment) external {
        IERC721 nft = IERC721(nftContract);
        require(nft.ownerOf(tokenId) == msg.sender, "Caller does not own NFT");
        require(commitment != 0, "Invalid commitment");

        nftCommitments[nftContract][tokenId] = commitment;
        emit NftCommitmentRegistered(nftContract, tokenId, msg.sender, commitment);
    }

    /**
     * @notice Deposit funds for confidential trading and register initial balance commitment.
     */
    function depositConfidentialFunds(uint256 initialBalanceCommitment) external payable nonReentrant {
        require(msg.value > 0, "Must deposit ETH");
        require(initialBalanceCommitment != 0, "Invalid balance commitment");

        escrowBalances[msg.sender] += msg.value;
        buyerBalanceCommitments[msg.sender] = initialBalanceCommitment;

        emit ConfidentialDeposit(msg.sender, msg.value, initialBalanceCommitment);
    }

    /**
     * @notice Withdraw funds from escrow with an updated commitment.
     */
    function withdrawConfidentialFunds(uint256 amount, uint256 newBalanceCommitment) external nonReentrant {
        require(amount > 0, "Amount must be > 0");
        require(escrowBalances[msg.sender] >= amount, "Insufficient escrow balance");

        escrowBalances[msg.sender] -= amount;
        buyerBalanceCommitments[msg.sender] = newBalanceCommitment;

        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Withdrawal failed");

        emit ConfidentialWithdrawal(msg.sender, amount, newBalanceCommitment);
    }

    // ====================================================
    // Zero-Knowledge Proof Verification & Trade Settlement
    // ====================================================

    /**
     * @notice Executes atomic confidential NFT trade settlement verified by ZK-SNARK.
     * 
     * Circuit public signals layout:
     *   pubSignals[0] = currentNftCommitment
     *   pubSignals[1] = currentBuyerBalanceCommitment
     *   pubSignals[2] = newNftCommitment
     *   pubSignals[3] = newBuyerBalanceCommitment
     *   pubSignals[4] = nftId
     *   pubSignals[5] = transactionPrice
     *   pubSignals[6] = sellerAddress (as field element)
     *   pubSignals[7] = buyerAddress (as field element)
     */
    function executeZkTrade(
        address nftContract,
        ZkTradeProof calldata proof
    ) external nonReentrant {
        // 1. Cryptographic proof verification via snarkjs Groth16 Verifier
        bool isValidProof = verifier.verifyProof(proof.a, proof.b, proof.c, proof.pubSignals);
        require(isValidProof, "Invalid ZK-SNARK proof");

        // 2. Extract and decode public signals
        uint256 currentNftCommitment = proof.pubSignals[0];
        uint256 currentBuyerBalanceCommitment = proof.pubSignals[1];
        uint256 newNftCommitment = proof.pubSignals[2];
        uint256 newBuyerBalanceCommitment = proof.pubSignals[3];
        uint256 nftId = proof.pubSignals[4];
        uint256 transactionPrice = proof.pubSignals[5];
        address seller = address(uint160(proof.pubSignals[6]));
        address buyer = address(uint160(proof.pubSignals[7]));

        // 3. Verify on-chain state matches circuit public signals
        require(nftCommitments[nftContract][nftId] == currentNftCommitment, "Mismatched NFT commitment");
        require(buyerBalanceCommitments[buyer] == currentBuyerBalanceCommitment, "Mismatched buyer balance commitment");

        // 4. Verify seller is the current on-chain owner
        IERC721 nft = IERC721(nftContract);
        require(nft.ownerOf(nftId) == seller, "Seller is no longer owner");
        require(
            nft.isApprovedForAll(seller, address(this)) || nft.getApproved(nftId) == address(this),
            "Marketplace not approved to transfer NFT"
        );

        // 5. Verify buyer escrow solvency
        require(escrowBalances[buyer] >= transactionPrice, "Insufficient buyer escrow balance");

        // 6. Update on-chain state commitments
        nftCommitments[nftContract][nftId] = newNftCommitment;
        buyerBalanceCommitments[buyer] = newBuyerBalanceCommitment;
        escrowBalances[buyer] -= transactionPrice;

        // Clear existing listing if any
        if (listings[nftContract][nftId].isActive) {
            listings[nftContract][nftId].isActive = false;
        }

        // 7. Execute atomic transfers
        // Pay seller
        (bool paymentSuccess, ) = payable(seller).call{value: transactionPrice}("");
        require(paymentSuccess, "Payment to seller failed");

        // Transfer NFT to buyer
        nft.safeTransferFrom(seller, buyer, nftId);

        emit ZkTradeSettled(
            nftContract,
            nftId,
            seller,
            buyer,
            transactionPrice,
            newNftCommitment
        );
    }
}

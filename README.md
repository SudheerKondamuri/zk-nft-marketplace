# ZK-SNARK Confidential NFT Marketplace

An enterprise-grade Zero-Knowledge SNARK implementation for confidential and verifiable NFT marketplace transactions using **Circom**, **SnarkJS**, **Solidity**, and **Hardhat**.

---

## 📌 Executive Summary

Traditional on-chain NFT marketplaces expose all transactional parameters: the buyer's wallet balance, the seller's holdings, and bidding history. This transparency opens users to front-running, balance stalking, and targeted financial profiling.

This project implements a privacy-preserving NFT marketplace protocol powered by **Groth16 zk-SNARKs**:
- **Confidential Balances**: Proves the buyer holds sufficient funds (`buyerBalance >= transactionPrice`) without revealing the buyer's total balance.
- **Verifiable Ownership**: Proves the seller legitimately owns the listed NFT via cryptographic commitment preimages (`Poseidon(nftId, sellerAddress, sellerSecretSalt)`).
- **Correct State Transition**: Enforces atomic state transitions (deducting the exact sale price from the buyer and assigning ownership of the NFT to the buyer).
- **On-Chain EVM Settlement**: Generates a pairing-friendly cryptographic proof off-chain and verifies it on-chain in `ZkNFTMarketplace.sol` via `Groth16Verifier.sol` in a single atomic transaction (~346k gas).

---

## 📐 Cryptographic Circuit Design

The Circom circuit (`circuits/nft_marketplace.circom`) is built on the **BN254 (alt_bn128)** elliptic curve using the algebraic **Poseidon** hash function for zero-knowledge efficiency.

### Circuit Signals

#### 1. Public Signals (8 signals verified on-chain)
| Signal Name | Description |
|---|---|
| `currentNftCommitment` | Poseidon hash commitment to the current seller's NFT ownership |
| `currentBuyerBalanceCommitment` | Poseidon hash commitment to the buyer's balance before trade |
| `newNftCommitment` | Updated Poseidon hash commitment representing the buyer's new ownership |
| `newBuyerBalanceCommitment` | Updated Poseidon hash commitment representing the buyer's post-trade balance |
| `nftId` | Unique token identifier of the NFT being traded |
| `transactionPrice` | Agreed execution price in wei |
| `sellerAddress` | Address of the current token owner |
| `buyerAddress` | Address of the purchasing party |

#### 2. Private Witness Inputs (5 confidential signals)
| Signal Name | Description |
|---|---|
| `sellerSecretSalt` | Secret salt known only to the seller proving ownership |
| `buyerBalance` | Actual private balance of the buyer (never exposed publicly) |
| `buyerBalanceSalt` | Blinding factor used in the initial balance commitment |
| `newNftSalt` | Fresh blinding factor for the buyer's new NFT commitment |
| `newBuyerBalanceSalt` | Fresh blinding factor for the buyer's updated balance commitment |

### In-Circuit Constraints

1. **Ownership Verification**:
   $$\text{currentNftCommitment} = \text{Poseidon}(\text{nftId}, \text{sellerAddress}, \text{sellerSecretSalt})$$
2. **Solvency Verification**:
   $$\text{currentBuyerBalanceCommitment} = \text{Poseidon}(\text{buyerAddress}, \text{buyerBalance}, \text{buyerBalanceSalt})$$
   $$\text{buyerBalance} \ge \text{transactionPrice} \quad (\text{using } \texttt{GreaterEqThan(64)})$$
3. **Price & Balance Transition**:
   $$\text{newBuyerBalance} = \text{buyerBalance} - \text{transactionPrice}$$
   $$\text{newBuyerBalanceCommitment} = \text{Poseidon}(\text{buyerAddress}, \text{newBuyerBalance}, \text{newBuyerBalanceSalt})$$
4. **NFT Transfer Verification**:
   $$\text{newNftCommitment} = \text{Poseidon}(\text{nftId}, \text{buyerAddress}, \text{newNftSalt})$$

- **Non-linear constraints**: 1,121
- **Wires**: 2,498
- **Proof Generation Time**: ~600 ms

---

## 🏗 Architecture & Smart Contracts

```
zk-nft-marketplace/
├── circuits/
│   └── nft_marketplace.circom      # Circom ZK-SNARK circuit definition
├── contracts/
│   ├── Groth16Verifier.sol         # Auto-generated on-chain Groth16 pairing verifier
│   ├── MockERC721.sol              # Standard ERC-721 token with minting & URI storage
│   └── ZkNFTMarketplace.sol        # Marketplace with standard & ZK settlement logic
├── scripts/
│   ├── compile_circuits.sh         # Circom compilation script
│   ├── setup_circuits.sh           # Powers of Tau ceremony & Solidity verifier exporter
│   ├── zk_utils.js                 # Cryptographic helpers (Poseidon, field conversions)
│   ├── generate_proof.js           # Groth16 witness & proof generation script
│   ├── verify_proof.js             # Off-chain proof verification script
│   └── demo_marketplace_tx.js      # Full end-to-end atomic deployment and trade demo
├── test/
│   ├── circuit.test.js             # Positive and negative circuit constraint unit tests
│   └── marketplace.test.js         # Hardhat integration tests (standard & ZK trade)
├── hardhat.config.js               # Hardhat configuration (Solidity 0.8.24, Cancun EVM)
└── package.json                    # Dependencies and scripts
```

### Smart Contract Highlights

1. **`MockERC721.sol`**:
   - OpenZeppelin v5 ERC721 implementation with `ERC721URIStorage` and `Ownable`.
   - Supports deterministic and auto-increment token minting.

2. **`Groth16Verifier.sol`**:
   - Generated directly by `snarkjs zkey export solidityverifier`.
   - Verifies the elliptic curve pairing equation $e(A, B) = e(\alpha, \beta) \cdot e(x \cdot \gamma, \delta) \cdot e(C, \delta)$ in EVM assembly.

3. **`ZkNFTMarketplace.sol`**:
   - **Standard Capabilities**:
     - `listItem(nft, tokenId, price)`
     - `cancelListing(nft, tokenId)`
     - `buyItem(nft, tokenId)`
     - `createBid(nft, tokenId)` (escrow-backed)
     - `cancelBid(nft, tokenId)`
     - `acceptBid(nft, tokenId, bidder)`
   - **Zero-Knowledge Capabilities**:
     - `registerNftCommitment(nft, tokenId, commitment)`: Seller registers their confidential state commitment on-chain.
     - `depositConfidentialFunds(commitment)`: Buyer deposits escrowed ETH bound to their balance commitment.
     - `executeZkTrade(nft, proof)`: Verifies the Groth16 proof, checks that public signals match registered on-chain state, executes atomic transfers (NFT to buyer, funds to seller), and stores updated state commitments.

---

## 🚀 Quickstart & Usage

### 1. Prerequisites
- **Node.js** v20+ / v26+
- **circom** v2.2.3+ (`circom --version`)
- **npm** v10+

### 2. Installation
Clone the repository and install all dependencies:
```bash
npm install
```

### 3. Circuit Compilation & Ceremony Setup
Compile the Circom circuit, run the Powers of Tau ceremony, and export `Groth16Verifier.sol`:
```bash
npm run setup:circuits
```

### 4. Generate & Verify Proofs Off-Chain
Generate a sample transaction proof with witness calculation:
```bash
npm run generate:proof
```
Output artifacts are saved in `build/proof/` (`proof.json`, `public.json`, `solidityCalldata.json`).

Verify the generated proof off-chain with SnarkJS:
```bash
npm run verify:proof
```

### 5. Run the Automated Test Suites
Run all 11 unit and integration tests (circuit constraints + smart contracts):
```bash
npm test
```

### 6. Run the Interactive End-to-End Demo
Executes a complete on-chain lifecycle: contract deployment, NFT minting, commitment registration, escrow deposit, proof generation, and atomic ZK settlement:
```bash
npm run demo
```

---

## 🧪 Test Coverage Summary

```text
  Circom Circuit: NftMarketplaceTransaction
    ✔ should successfully generate and verify a proof for a valid transaction (1912ms)
    ✔ should fail constraint check if buyer balance is insufficient (buyerBalance < price) (105ms)
    ✔ should fail constraint check if seller does not know the secret salt for the NFT (101ms)
    ✔ should fail constraint check if updated balance is computed incorrectly (102ms)

  ZkNFTMarketplace End-to-End Suite
    1. Standard NFT Marketplace Capabilities
      ✔ should allow a seller to list an NFT and cancel listing (43ms)
      ✔ should allow a buyer to directly purchase a listed NFT
      ✔ should support bidding: create bid, outbid, cancel bid, and accept bid (52ms)
    2. Zero-Knowledge Confidential Marketplace Settlement
      ✔ should execute confidential trade atomically via ZK-SNARK verification (44ms)
      ✔ should revert if an invalid or tampered ZK-SNARK proof is supplied (39ms)
      ✔ should revert if public signals do not match registered on-chain NFT commitment
      ✔ should revert if public signals do not match buyer registered balance commitment

  11 passing (7s)
```

---

## 🔒 Security & Privacy Guarantees

1. **Zero-Knowledge Property**: The proof reveals zero information about the buyer's total account balance or the seller's secret salt beyond what is mathematically implied by the trade.
2. **Cryptographic Soundness**: A malicious buyer cannot forge a proof with an insufficient balance; the `GreaterEqThan(64)` constraint guarantees that $buyerBalance - transactionPrice \ge 0$.
3. **Front-Running & Tamper Resistance**: All transaction-specific parameters (`nftId`, `transactionPrice`, `sellerAddress`, `buyerAddress`) are bound as public inputs to the Groth16 proof. Any modification invalidates the pairing checks.
4. **Reentrancy Protection**: All state modifications in `ZkNFTMarketplace.sol` adhere to the **Checks-Effects-Interactions** pattern guarded by OpenZeppelin's `ReentrancyGuard`.

---

## 📜 License
MIT © 2026 Kondamuri Satya Sudheer

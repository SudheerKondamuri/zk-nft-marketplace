#!/usr/bin/env bash
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
ROOT_DIR="$(dirname "$DIR")"
BUILD_DIR="$ROOT_DIR/build/circuits"
CEREMONY_DIR="$ROOT_DIR/build/ceremony"

mkdir -p "$BUILD_DIR"
mkdir -p "$CEREMONY_DIR"
mkdir -p "$ROOT_DIR/contracts"

echo "=== [1/5] Compiling Circom Circuit ==="
circom "$ROOT_DIR/circuits/nft_marketplace.circom" --r1cs --wasm --sym -o "$BUILD_DIR"

echo "=== [2/5] Starting Powers of Tau Ceremony ==="
if [ ! -f "$CEREMONY_DIR/pot12_final.ptau" ]; then
    npx snarkjs powersoftau new bn128 12 "$CEREMONY_DIR/pot12_0000.ptau" -v
    npx snarkjs powersoftau contribute "$CEREMONY_DIR/pot12_0000.ptau" "$CEREMONY_DIR/pot12_0001.ptau" --name="Partnr Contribution" -v -e="random entropy for zk marketplace"
    npx snarkjs powersoftau prepare phase2 "$CEREMONY_DIR/pot12_0001.ptau" "$CEREMONY_DIR/pot12_final.ptau" -v
fi

echo "=== [3/5] Groth16 Circuit Setup ==="
npx snarkjs groth16 setup "$BUILD_DIR/nft_marketplace.r1cs" "$CEREMONY_DIR/pot12_final.ptau" "$BUILD_DIR/nft_marketplace_0000.zkey"
npx snarkjs zkey contribute "$BUILD_DIR/nft_marketplace_0000.zkey" "$BUILD_DIR/nft_marketplace_final.zkey" --name="Marketplace Setup" -v -e="entropy for zkey generation"

echo "=== [4/5] Exporting Verification Key ==="
npx snarkjs zkey export verification_key "$BUILD_DIR/nft_marketplace_final.zkey" "$BUILD_DIR/verification_key.json"

echo "=== [5/5] Generating Solidity Verifier Contract ==="
npx snarkjs zkey export solidityverifier "$BUILD_DIR/nft_marketplace_final.zkey" "$ROOT_DIR/contracts/Groth16Verifier.sol"

echo "Circuit compilation, trusted setup, and Solidity verifier generation completed successfully!"

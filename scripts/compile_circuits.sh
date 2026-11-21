#!/usr/bin/env bash
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
ROOT_DIR="$(dirname "$DIR")"
BUILD_DIR="$ROOT_DIR/build/circuits"

mkdir -p "$BUILD_DIR"
echo "Compiling Circom circuits..."
circom "$ROOT_DIR/circuits/nft_marketplace.circom" --r1cs --wasm --sym -o "$BUILD_DIR"
echo "Circuit compiled successfully to $BUILD_DIR"

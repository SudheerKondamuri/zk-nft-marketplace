const { buildPoseidon } = require("circomlibjs");
const crypto = require("crypto");

let poseidonInstance = null;

async function getPoseidon() {
    if (!poseidonInstance) {
        poseidonInstance = await buildPoseidon();
    }
    return poseidonInstance;
}

const SNARK_FIELD_SIZE = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");

function randomFieldElement() {
    const bytes = crypto.randomBytes(31);
    const hex = "0x" + bytes.toString("hex");
    return BigInt(hex) % SNARK_FIELD_SIZE;
}

async function hash3(a, b, c) {
    const poseidon = await getPoseidon();
    const h = poseidon([BigInt(a), BigInt(b), BigInt(c)]);
    return poseidon.F.toString(h);
}

// Convert an Ethereum address (hex string) to a Field element BigInt
function addressToField(address) {
    return BigInt(address).toString();
}

module.exports = {
    getPoseidon,
    SNARK_FIELD_SIZE,
    randomFieldElement,
    hash3,
    addressToField,
};

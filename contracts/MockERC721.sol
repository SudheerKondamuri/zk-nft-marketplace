// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockERC721
 * @notice Standard ERC721 implementation for testing the ZK NFT Marketplace.
 */
contract MockERC721 is ERC721URIStorage, Ownable {
    uint256 private _nextTokenId;

    event TokenMinted(address indexed recipient, uint256 indexed tokenId, string tokenURI);

    constructor(
        string memory name_,
        string memory symbol_,
        address initialOwner
    ) ERC721(name_, symbol_) Ownable(initialOwner) {
        _nextTokenId = 1;
    }

    /**
     * @notice Mint a new token with an auto-incremented ID and specified URI.
     */
    function mint(address recipient, string memory uri) public returns (uint256) {
        uint256 tokenId = _nextTokenId++;
        _safeMint(recipient, tokenId);
        _setTokenURI(tokenId, uri);
        emit TokenMinted(recipient, tokenId, uri);
        return tokenId;
    }

    /**
     * @notice Mint a token with a specific ID (useful for matching circuit parameters in tests).
     */
    function mintWithId(address recipient, uint256 tokenId, string memory uri) public returns (uint256) {
        _safeMint(recipient, tokenId);
        _setTokenURI(tokenId, uri);
        emit TokenMinted(recipient, tokenId, uri);
        return tokenId;
    }
}

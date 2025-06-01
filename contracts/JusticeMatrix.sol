// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract JusticeMatrix {
    string public message;

    constructor() {
        message = "Justice Matrix: Truth and Accountability";
    }

    function updateMessage(string calldata newMessage) external {
        message = newMessage;
    }
}
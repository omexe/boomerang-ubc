// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

interface IMintable {
    function mint(address to, uint256 amount) external;
}

interface IMessageHandler {
    function handleReceiveFinalizedMessage(
        uint32 sourceDomain,
        bytes32 sender,
        uint32 finalityThresholdExecuted,
        bytes calldata messageBody
    ) external returns (bool);
}

/// A stand-in for Circle's CCTP V2 MessageTransmitterV2, for tests. Like Circle's, it reads
/// the message header, enforces the allowed caller and the one-use nonce with Circle's own
/// revert strings, and then hands the body to whatever contract the header names as the
/// recipient. That last step matters: Circle attests any message anyone sends, so the
/// recipient can be an attacker's contract. It checks no signatures: any 65-byte attestation
/// passes. Never deployed for real use.
contract TestTransmitter {
    mapping(bytes32 => bool) public usedNonces;

    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool) {
        require(attestation.length == 65, "Invalid attestation length");
        require(message.length >= 148, "Invalid message: too short");
        bytes32 caller = bytes32(message[108:140]);
        if (caller != bytes32(0)) {
            require(caller == bytes32(uint256(uint160(msg.sender))), "Invalid caller for message");
        }
        bytes32 nonce = bytes32(message[12:44]);
        require(!usedNonces[nonce], "Nonce already used");
        usedNonces[nonce] = true;

        address recipient = address(uint160(uint256(bytes32(message[76:108]))));
        require(
            IMessageHandler(recipient).handleReceiveFinalizedMessage(
                uint32(bytes4(message[4:8])), bytes32(message[44:76]), uint32(bytes4(message[144:148])), message[148:]
            ),
            "handleReceiveFinalizedMessage() failed"
        );
        return true;
    }
}

/// A stand-in for Circle's TokenMessengerV2: only the transmitter may call it, and it mints
/// the burned amount less the executed fee to the mint recipient named in the burn message.
contract TestMessenger is IMessageHandler {
    IMintable public immutable token;
    address public immutable transmitter;

    constructor(address token_, address transmitter_) {
        token = IMintable(token_);
        transmitter = transmitter_;
    }

    function handleReceiveFinalizedMessage(uint32, bytes32, uint32, bytes calldata body) external returns (bool) {
        require(msg.sender == transmitter, "Invalid message transmitter");
        require(body.length >= 228, "Invalid burn message: too short");
        address mintRecipient = address(uint160(uint256(bytes32(body[36:68]))));
        uint256 amount = uint256(bytes32(body[68:100]));
        uint256 fee = uint256(bytes32(body[164:196]));
        require(fee == 0 || fee < amount, "Fee equals or exceeds amount");
        token.mint(mintRecipient, amount - fee);
        return true;
    }
}

/// An attacker's message recipient. When the transmitter hands it a message, it uses the
/// moment to receive someone else's waiting message, then reports success.
contract ThiefHandler is IMessageHandler {
    TestTransmitter public immutable transmitter;
    bytes public victimMessage;
    bytes public attestation;

    constructor(address transmitter_) {
        transmitter = TestTransmitter(transmitter_);
    }

    function aim(bytes calldata victimMessage_, bytes calldata attestation_) external {
        victimMessage = victimMessage_;
        attestation = attestation_;
    }

    function handleReceiveFinalizedMessage(uint32, bytes32, uint32, bytes calldata) external returns (bool) {
        transmitter.receiveMessage(victimMessage, attestation);
        return true;
    }
}

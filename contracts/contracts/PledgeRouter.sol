// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

interface IRouterToken {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// The one function this contract uses of Circle's CCTP V2 MessageTransmitterV2.
interface ITransmitter {
    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool);
}

interface IBoomerangPledge {
    function pledgeFor(uint256 id, address backer, uint256 amount) external returns (uint256 taken);
}

/// Turns USDC arriving from another chain into a pledge, in one transaction.
///
/// A backer burns USDC on the source chain with CCTP V2 (Circle's token messenger there,
/// which addresses the message to its token messenger here), naming this contract as the mint
/// recipient and as the only allowed caller, with hook data `abi.encode(campaignId, backer)`.
/// Anyone may then call `relay` with the attested message. The router receives the mint and
/// pledges it for the backer. Whatever the campaign does not take (all of it, if the pledge
/// is refused) goes to the backer's address on this chain in the same transaction.
///
/// The router has no owner and keeps nothing between calls. It cannot recover USDC that
/// reaches it any other way: a burn that does not name it as the only allowed caller can be
/// received by anyone directly at the transmitter, and that mint would stay here.
contract PledgeRouter {
    // Offsets in a CCTP V2 message whose body is a V2 burn message. The header is 148 bytes;
    // in the body the mint recipient is at 36 and the hook data starts at 228.
    uint256 private constant NONCE_AT = 12;
    uint256 private constant RECIPIENT_AT = 76;
    uint256 private constant MINT_RECIPIENT_AT = 184;
    uint256 private constant HOOK_AT = 376;
    uint256 private constant HOOK_LENGTH = 64;

    /// Gas that must remain before the pledge is tried, so that a relayer cannot make a good
    /// pledge fail by sending too little gas. A pledge uses well under this.
    uint256 public constant PLEDGE_GAS = 400_000;

    IRouterToken public immutable usdc;
    IBoomerangPledge public immutable boomerang;
    ITransmitter public immutable transmitter;
    /// Circle's TokenMessengerV2 on this chain: the only message recipient the router accepts.
    address public immutable messenger;

    bool private _entered;

    /// One relayed message: what arrived, what the campaign took, what went to the backer.
    event Relayed(
        bytes32 indexed nonce,
        uint256 indexed campaignId,
        address indexed backer,
        uint256 minted,
        uint256 pledged,
        uint256 forwarded
    );

    error ZeroAddress();
    error BadHook();
    error NotABurn();
    error NotForRouter();
    error ReceiveFailed();
    error NothingMinted();
    error LowGas();
    error TokenFailed();
    error Reentered();

    constructor(address usdc_, address boomerang_, address transmitter_, address messenger_) {
        if (usdc_ == address(0) || boomerang_ == address(0) || transmitter_ == address(0) || messenger_ == address(0)) {
            revert ZeroAddress();
        }
        messenger = messenger_;
        usdc = IRouterToken(usdc_);
        boomerang = IBoomerangPledge(boomerang_);
        transmitter = ITransmitter(transmitter_);
    }

    /// Receive an attested CCTP mint addressed to this router and pledge it for the backer
    /// named in its hook data. Open to anyone. Reverts, leaving the message unreceived and
    /// relayable later, if the message is not a burn through Circle's token messenger, is not for the router, its hook data is not exactly a
    /// campaign id and a backer address, too little gas was sent, or the backer cannot be paid.
    function relay(bytes calldata message, bytes calldata attestation)
        external
        returns (uint256 pledged, uint256 forwarded)
    {
        if (_entered) revert Reentered();
        _entered = true;

        if (message.length != HOOK_AT + HOOK_LENGTH) revert BadHook();
        // Circle attests any message anyone sends, and its transmitter hands the body to the
        // recipient named in the header. Only Circle's own token messenger is accepted here,
        // so the body is a real burn and no stranger's code runs while the router is measuring.
        if (bytes32(message[RECIPIENT_AT:RECIPIENT_AT + 32]) != bytes32(uint256(uint160(messenger)))) {
            revert NotABurn();
        }
        if (bytes32(message[MINT_RECIPIENT_AT:MINT_RECIPIENT_AT + 32]) != bytes32(uint256(uint160(address(this))))) {
            revert NotForRouter();
        }
        (uint256 campaignId, uint256 rawBacker) = abi.decode(message[HOOK_AT:], (uint256, uint256));
        if (rawBacker == 0 || rawBacker >> 160 != 0 || rawBacker == uint256(uint160(address(this)))) revert BadHook();
        address backer = address(uint160(rawBacker));

        // What arrived is read from the balance, so a fee taken by CCTP is already out of it.
        uint256 before = usdc.balanceOf(address(this));
        if (!transmitter.receiveMessage(message, attestation)) revert ReceiveFailed();
        uint256 minted = usdc.balanceOf(address(this)) - before;
        if (minted == 0) revert NothingMinted();

        if (gasleft() < PLEDGE_GAS) revert LowGas();
        _token(abi.encodeCall(IRouterToken.approve, (address(boomerang), minted)));
        try boomerang.pledgeFor(campaignId, backer, minted) {} catch {}
        _token(abi.encodeCall(IRouterToken.approve, (address(boomerang), 0)));

        // What the campaign took is also read from the balance, not from its answer.
        forwarded = usdc.balanceOf(address(this)) - before;
        pledged = minted - forwarded;
        if (forwarded > 0) _token(abi.encodeCall(IRouterToken.transfer, (backer, forwarded)));

        emit Relayed(bytes32(message[NONCE_AT:NONCE_AT + 32]), campaignId, backer, minted, pledged, forwarded);
        _entered = false;
    }

    /// A token call must succeed, answering nothing or true.
    function _token(bytes memory data) private {
        (bool ok, bytes memory answer) = address(usdc).call(data);
        if (!ok || !(answer.length == 0 || (answer.length >= 32 && abi.decode(answer, (bool))))) revert TokenFailed();
    }
}

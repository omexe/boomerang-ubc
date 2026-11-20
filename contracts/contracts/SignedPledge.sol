// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// The part of Circle's USDC this helper uses: EIP-3009's receive authorization, which only the
/// payee named in the signature can submit.
interface ISignedToken {
    function balanceOf(address account) external view returns (uint256);

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

interface ISignedBoomerang {
    function pledgeFor(uint256 id, address backer, uint256 amount) external returns (uint256 taken);
}

/// A pledge made from one signature. The backer signs Circle's ReceiveWithAuthorization once:
/// the payee is this contract, and the signature's nonce is `nonceFor(id, amount, salt)`, so it
/// can move the backer's USDC only into campaign `id`, only `amount` of it, only once and only
/// inside its window. Anyone may submit it (in the app, the keeper does, and pays the gas).
///
/// In one transaction it takes the USDC, pledges it for the backer with Boomerang's `pledgeFor`
/// (the backer owns the record and every payout), and sends back what the campaign did not take.
/// A pledge the campaign refuses is not caught: the whole call reverts, the USDC never leaves
/// the backer and the signature stays unused until its window ends. No owner, nothing held
/// between calls, no way to move money except as the signature says.
contract SignedPledge {
    ISignedToken public immutable usdc;
    ISignedBoomerang public immutable boomerang;

    /// The backer's signature over Circle's ReceiveWithAuthorization, and its window and salt.
    struct Authorization {
        uint256 validAfter;
        uint256 validBefore;
        bytes32 salt;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    bool private _entered;

    event SignedPledged(uint256 indexed id, address indexed backer, uint256 amount, uint256 taken, uint256 returned);

    error ZeroAddress();
    error Reentered();
    error TokenFailed();

    constructor(address usdc_, address boomerang_) {
        if (usdc_ == address(0) || boomerang_ == address(0)) revert ZeroAddress();
        usdc = ISignedToken(usdc_);
        boomerang = ISignedBoomerang(boomerang_);
    }

    /// The nonce a backer signs: it binds the authorization to one campaign and one amount.
    function nonceFor(uint256 id, uint256 amount, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(id, amount, salt));
    }

    function pledgeSigned(uint256 id, address backer, uint256 amount, Authorization calldata a) external returns (uint256 taken) {
        if (_entered) revert Reentered();
        _entered = true;
        if (backer == address(0)) revert ZeroAddress();

        // Measured from the balance, so USDC sent here by mistake is never handed to a backer.
        uint256 before = usdc.balanceOf(address(this));
        usdc.receiveWithAuthorization(backer, address(this), amount, a.validAfter, a.validBefore, nonceFor(id, amount, a.salt), a.v, a.r, a.s);
        if (usdc.balanceOf(address(this)) - before != amount) revert TokenFailed();

        _token(abi.encodeWithSignature("approve(address,uint256)", address(boomerang), amount));
        taken = boomerang.pledgeFor(id, backer, amount);
        _token(abi.encodeWithSignature("approve(address,uint256)", address(boomerang), 0));

        uint256 returned = usdc.balanceOf(address(this)) - before;
        if (returned > 0) _token(abi.encodeWithSignature("transfer(address,uint256)", backer, returned));

        emit SignedPledged(id, backer, amount, taken, returned);
        _entered = false;
    }

    /// A token call must succeed, answering nothing or true.
    function _token(bytes memory data) private {
        (bool ok, bytes memory answer) = address(usdc).call(data);
        if (!ok || !(answer.length == 0 || (answer.length >= 32 && abi.decode(answer, (bool))))) revert TokenFailed();
    }
}

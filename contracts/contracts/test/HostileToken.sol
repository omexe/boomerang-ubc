// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// A 6-decimal test token that can be armed to call back into a target during a transfer.
/// It stands in for a malicious ERC-20 that tries to re-enter its counterparty while tokens
/// move. When armed, the first `transfer` (or `transferFrom`, depending on the arming) makes a
/// low-level call into the target with stored calldata, records whether that inner call
/// succeeded and what it returned, then completes the move as usual. Used only by A18.
contract HostileToken {
    string public constant name = "Hostile USDC";
    string public constant symbol = "hUSDC";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // --- re-entry controls ---
    address public reenterTarget; // contract to call back into
    bytes public reenterData; // calldata for that call
    bool public onTransfer; // fire during transfer
    bool public onTransferFrom; // fire during transferFrom
    bool public fired; // the callback runs at most once per arming

    // --- what the callback saw ---
    bool public lastInnerOk; // did the inner call succeed
    bytes public lastInnerReturn; // its return data, or the revert reason

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    /// Point the token at a target and arm it to call back during transfer and/or transferFrom.
    function arm(address target, bytes calldata data, bool duringTransfer, bool duringTransferFrom) external {
        reenterTarget = target;
        reenterData = data;
        onTransfer = duringTransfer;
        onTransferFrom = duringTransferFrom;
        fired = false;
        lastInnerOk = false;
        delete lastInnerReturn;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (onTransfer) _fire();
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (onTransferFrom) _fire();
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }

    /// Call back into the target once, recording the outcome without reverting the transfer.
    function _fire() private {
        if (fired) return;
        fired = true;
        (bool ok, bytes memory ret) = reenterTarget.call(reenterData);
        lastInnerOk = ok;
        lastInnerReturn = ret;
    }

    function _move(address from, address to, uint256 amount) private {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

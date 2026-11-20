// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// A 6-decimal test token that can be switched into the ways real tokens misbehave:
/// answering "no" instead of reverting, answering nothing at all (as USDT does), keeping a
/// fee from every transfer, or answering with a malformed reply. Never deployed for real use.
contract OddToken {
    enum Mode {
        Normal, // moves the money and answers true
        SaysNo, // moves nothing and answers false
        Silent, // moves the money and answers with no data
        Fee, // moves the money less one percent, which is burned, and answers true
        Garbled // moves the money and answers with a single byte
    }

    string public constant name = "Odd USDC";
    string public constant symbol = "oUSDC";
    uint8 public constant decimals = 6;

    Mode public mode;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    function setMode(Mode next) external {
        mode = next;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (mode == Mode.SaysNo) return false;
        _move(msg.sender, to, amount);
        _answer();
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (mode == Mode.SaysNo) return false;
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        _answer();
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        uint256 fee = mode == Mode.Fee ? amount / 100 : 0;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
        emit Transfer(from, to, amount - fee);
    }

    /// In the Silent and Garbled modes, end the call here with no data or with one byte.
    function _answer() private view {
        if (mode == Mode.Silent) {
            assembly {
                return(0, 0)
            }
        }
        if (mode == Mode.Garbled) {
            assembly {
                mstore8(0, 1)
                return(0, 1)
            }
        }
    }
}

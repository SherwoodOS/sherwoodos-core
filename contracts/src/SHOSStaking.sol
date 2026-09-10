// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20Min {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

contract SHOSStaking {
    IERC20Min public immutable shos;
    uint8 public immutable tokenDecimals;

    struct Tier {
        uint256 minStake;
        uint16 discountBps;
    }

    Tier[] public tiers;
    mapping(address => uint256) public stakedOf;
    uint256 public totalStaked;

    event Staked(address indexed account, uint256 amount, uint256 total);
    event Unstaked(address indexed account, uint256 amount, uint256 total);

    constructor(address shos_, uint8 decimals_) {
        require(shos_ != address(0), "shos");
        shos = IERC20Min(shos_);
        tokenDecimals = decimals_;
        uint256 unit = 10 ** uint256(decimals_);

        tiers.push(Tier(10_000 * unit, 1_000));
        tiers.push(Tier(100_000 * unit, 2_500));
        tiers.push(Tier(1_000_000 * unit, 5_000));
    }

    function tierCount() external view returns (uint256) {
        return tiers.length;
    }

    function stake(uint256 amount) external {
        require(amount > 0, "stake: zero");
        uint256 before = shos.balanceOf(address(this));
        _call(abi.encodeWithSelector(IERC20Min.transferFrom.selector, msg.sender, address(this), amount), "stake: transfer");
        uint256 received = shos.balanceOf(address(this)) - before;
        require(received > 0, "stake: nothing received");
        stakedOf[msg.sender] += received;
        totalStaked += received;
        emit Staked(msg.sender, received, stakedOf[msg.sender]);
    }

    function unstake(uint256 amount) external {
        uint256 bal = stakedOf[msg.sender];
        require(amount > 0 && amount <= bal, "unstake: amount");
        stakedOf[msg.sender] = bal - amount;
        totalStaked -= amount;
        _call(abi.encodeWithSelector(IERC20Min.transfer.selector, msg.sender, amount), "unstake: transfer");
        emit Unstaked(msg.sender, amount, stakedOf[msg.sender]);
    }

    function discountBpsOf(address account) public view returns (uint16 discount) {
        uint256 s = stakedOf[account];
        for (uint256 i = 0; i < tiers.length; i++) {
            if (s >= tiers[i].minStake) discount = tiers[i].discountBps;
        }
    }

    function _call(bytes memory data, string memory err) internal {
        (bool ok, bytes memory ret) = address(shos).call(data);
        if (!ok) {
            if (ret.length > 0) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            revert(err);
        }
        require(ret.length == 0 || abi.decode(ret, (bool)), err);
    }
}

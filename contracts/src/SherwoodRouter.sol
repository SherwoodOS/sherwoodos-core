// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IUSDG} from "./interfaces/IUSDG.sol";

interface ISHOSStaking {
    function discountBpsOf(address account) external view returns (uint16);
}

contract SherwoodRouter {
    IUSDG public immutable usdg;
    ISHOSStaking public staking;

    address public owner;
    address public facilitator;
    address public treasury;
    uint16 public feeBps;

    struct App {
        address provider;
        uint96 price;
        bool active;
        string name;
    }

    struct Policy {
        uint128 dailyLimit;
        uint128 perRequestMax;
        address agentOwner;
        bool active;
    }

    mapping(bytes32 => App) public apps;
    bytes32[] public appIds;

    mapping(address => Policy) public policies;
    mapping(address => mapping(bytes32 => uint128)) public perAppDailyLimit;
    mapping(address => mapping(uint256 => uint256)) public spentOnDay;
    mapping(address => mapping(bytes32 => mapping(uint256 => uint256))) public spentOnAppDay;

    uint256 public receiptCount;
    uint256 public totalSettled;
    mapping(bytes32 => uint256) public appCalls;

    event OwnerChanged(address indexed owner);
    event FacilitatorChanged(address indexed facilitator);
    event TreasuryChanged(address indexed treasury, uint16 feeBps);
    event AppSet(bytes32 indexed appId, string name, address provider, uint256 price, bool active);
    event PolicySet(address indexed agent, address indexed agentOwner, uint256 dailyLimit, uint256 perRequestMax, bool active);
    event AppLimitSet(address indexed agent, bytes32 indexed appId, uint256 dailyLimit);
    event Paid(
        bytes32 indexed receiptId,
        address indexed agent,
        bytes32 indexed appId,
        address provider,
        uint256 amount,
        uint256 fee,
        bytes32 nonce,
        uint256 receiptNo
    );

    error NotOwner();
    error NotFacilitator();
    error AppInactive();
    error BadAmount(uint256 expected, uint256 got);
    error NoPolicy();
    error PerRequestLimit(uint256 max, uint256 got);
    error DailyLimit(uint256 limit, uint256 wouldBe);
    error AppDailyLimit(uint256 limit, uint256 wouldBe);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address usdg_, address staking_, address treasury_, uint16 feeBps_) {
        require(usdg_ != address(0), "usdg");
        require(treasury_ != address(0), "treasury");
        require(feeBps_ <= 2_000, "fee > 20%");
        usdg = IUSDG(usdg_);
        staking = ISHOSStaking(staking_);
        owner = msg.sender;
        facilitator = msg.sender;
        treasury = treasury_;
        feeBps = feeBps_;
    }

    function setOwner(address o) external onlyOwner {
        require(o != address(0), "owner");
        owner = o;
        emit OwnerChanged(o);
    }

    function setFacilitator(address f) external onlyOwner {
        require(f != address(0), "facilitator");
        facilitator = f;
        emit FacilitatorChanged(f);
    }

    function setTreasury(address t, uint16 bps) external onlyOwner {
        require(t != address(0), "treasury");
        require(bps <= 2_000, "fee > 20%");
        treasury = t;
        feeBps = bps;
        emit TreasuryChanged(t, bps);
    }

    function setStaking(address s) external onlyOwner {
        staking = ISHOSStaking(s);
    }

    function setApp(bytes32 appId, string calldata name, address provider, uint96 price, bool active) external onlyOwner {
        require(provider != address(0), "provider");
        if (apps[appId].provider == address(0)) appIds.push(appId);
        apps[appId] = App(provider, price, active, name);
        emit AppSet(appId, name, provider, price, active);
    }

    function setPolicy(address agent, address agentOwner, uint128 dailyLimit, uint128 perRequestMax, bool active)
        external
        onlyOwner
    {
        policies[agent] = Policy(dailyLimit, perRequestMax, agentOwner, active);
        emit PolicySet(agent, agentOwner, dailyLimit, perRequestMax, active);
    }

    function setAppLimit(address agent, bytes32 appId, uint128 dailyLimit) external onlyOwner {
        perAppDailyLimit[agent][appId] = dailyLimit;
        emit AppLimitSet(agent, appId, dailyLimit);
    }

    function appCount() external view returns (uint256) {
        return appIds.length;
    }

    function feeFor(address agent, uint256 price) public view returns (uint256 fee) {
        fee = (price * feeBps) / 10_000;
        address o = policies[agent].agentOwner;
        if (o != address(0) && address(staking) != address(0)) {
            uint16 d = staking.discountBpsOf(o);
            fee = fee - (fee * d) / 10_000;
        }
    }

    function quote(bytes32 appId, address agent) external view returns (uint256 price, uint256 fee, uint256 total) {
        App storage a = apps[appId];
        price = a.price;
        fee = feeFor(agent, price);
        total = price + fee;
    }

    function remainingToday(address agent) external view returns (uint256) {
        Policy storage p = policies[agent];
        uint256 spent = spentOnDay[agent][block.timestamp / 1 days];
        return spent >= p.dailyLimit ? 0 : p.dailyLimit - spent;
    }

    struct Authorization {
        address from;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    function settle(bytes32 appId, Authorization calldata a) external returns (bytes32 receiptId) {
        if (msg.sender != facilitator) revert NotFacilitator();
        App storage app = apps[appId];
        if (!app.active) revert AppInactive();

        uint256 fee = feeFor(a.from, app.price);
        if (a.value != uint256(app.price) + fee) revert BadAmount(uint256(app.price) + fee, a.value);

        _charge(a.from, appId, a.value);

        usdg.receiveWithAuthorization(a.from, address(this), a.value, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s);

        require(usdg.transfer(app.provider, a.value - fee), "provider transfer");
        if (fee > 0) require(usdg.transfer(treasury, fee), "fee transfer");

        receiptCount += 1;
        totalSettled += a.value;
        appCalls[appId] += 1;
        receiptId = keccak256(abi.encodePacked(a.from, appId, a.nonce));
        emit Paid(receiptId, a.from, appId, app.provider, a.value, fee, a.nonce, receiptCount);
    }

    function _charge(address from, bytes32 appId, uint256 value) internal {
        Policy storage p = policies[from];
        if (!p.active) revert NoPolicy();
        if (value > p.perRequestMax) revert PerRequestLimit(p.perRequestMax, value);

        uint256 day = block.timestamp / 1 days;
        uint256 spent = spentOnDay[from][day] + value;
        if (spent > p.dailyLimit) revert DailyLimit(p.dailyLimit, spent);
        spentOnDay[from][day] = spent;

        uint128 appLimit = perAppDailyLimit[from][appId];
        if (appLimit != 0) {
            uint256 appSpent = spentOnAppDay[from][appId][day] + value;
            if (appSpent > appLimit) revert AppDailyLimit(appLimit, appSpent);
            spentOnAppDay[from][appId][day] = appSpent;
        }
    }
}

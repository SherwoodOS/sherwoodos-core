// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SHOS} from "../src/SHOS.sol";
import {SHOSStaking} from "../src/SHOSStaking.sol";
import {SherwoodRouter} from "../src/SherwoodRouter.sol";
import {IUSDG} from "../src/interfaces/IUSDG.sol";

contract SherwoodRouterTest is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    bytes32 constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    SHOS shos;
    SHOSStaking staking;
    SherwoodRouter router;

    uint256 agentKey = 0xA11CE;
    address agent;
    address provider = address(0xBEEF);
    address treasury = address(0xFEE);
    bytes32 appId = keccak256("market-data");

    function setUp() public {
        vm.createSelectFork(vm.envString("FORK_RPC_URL"));
        agent = vm.addr(agentKey);

        shos = new SHOS(address(this));
        staking = new SHOSStaking(address(shos), 18);
        router = new SherwoodRouter(USDG, address(staking), treasury, 300);
        router.setApp(appId, "Market Data", provider, 10_000, true);
        router.setPolicy(agent, address(this), 5_000_000, 250_000, true);

        fundUSDG(agent, 25_000_000);
    }

    function fundUSDG(address who, uint256 amount) internal {
        bytes32 slot = keccak256(abi.encode(who, uint256(1)));
        vm.store(USDG, slot, bytes32(amount));
        assertEq(IUSDG(USDG).balanceOf(who), amount);
    }

    function sign(uint256 key, address from, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Global Dollar"),
                keccak256("1"),
                block.chainid,
                USDG
            )
        );
        bytes32 structHash =
            keccak256(abi.encode(RECEIVE_TYPEHASH, from, address(router), value, validAfter, validBefore, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        (v, r, s) = vm.sign(key, digest);
    }

    function testSettleSplitsFeeAndEmitsReceipt() public {
        (, uint256 fee, uint256 total) = router.quote(appId, agent);
        assertEq(fee, 300);
        assertEq(total, 10_300);
        bytes32 nonce = keccak256("n1");
        (uint8 v, bytes32 r, bytes32 s) = sign(agentKey, agent, total, 0, block.timestamp + 60, nonce);

        bytes32 id = router.settle(appId, SherwoodRouter.Authorization(agent, total, 0, block.timestamp + 60, nonce, v, r, s));
        assertEq(id, keccak256(abi.encodePacked(agent, appId, nonce)));
        assertEq(IUSDG(USDG).balanceOf(provider), 10_000);
        assertEq(IUSDG(USDG).balanceOf(treasury), 300);
        assertEq(IUSDG(USDG).balanceOf(agent), 25_000_000 - 10_300);
        assertEq(router.receiptCount(), 1);
        assertEq(router.appCalls(appId), 1);
        assertTrue(IUSDG(USDG).authorizationState(agent, nonce));
    }

    function testReplayIsRejectedByUSDG() public {
        (,, uint256 total) = router.quote(appId, agent);
        bytes32 nonce = keccak256("n2");
        (uint8 v, bytes32 r, bytes32 s) = sign(agentKey, agent, total, 0, block.timestamp + 60, nonce);
        router.settle(appId, SherwoodRouter.Authorization(agent, total, 0, block.timestamp + 60, nonce, v, r, s));
        vm.expectRevert();
        router.settle(appId, SherwoodRouter.Authorization(agent, total, 0, block.timestamp + 60, nonce, v, r, s));
    }

    function testDailyLimitEnforced() public {
        router.setPolicy(agent, address(this), 20_000, 250_000, true);
        (,, uint256 total) = router.quote(appId, agent);
        bytes32 n1 = keccak256("d1");
        (uint8 v, bytes32 r, bytes32 s) = sign(agentKey, agent, total, 0, block.timestamp + 60, n1);
        router.settle(appId, SherwoodRouter.Authorization(agent, total, 0, block.timestamp + 60, n1, v, r, s));
        bytes32 n2 = keccak256("d2");
        (v, r, s) = sign(agentKey, agent, total, 0, block.timestamp + 60, n2);
        vm.expectRevert(abi.encodeWithSelector(SherwoodRouter.DailyLimit.selector, 20_000, 20_600));
        router.settle(appId, SherwoodRouter.Authorization(agent, total, 0, block.timestamp + 60, n2, v, r, s));
    }

    function testPerAppLimitEnforced() public {
        router.setAppLimit(agent, appId, 10_300);
        (,, uint256 total) = router.quote(appId, agent);
        bytes32 n1 = keccak256("a1");
        (uint8 v, bytes32 r, bytes32 s) = sign(agentKey, agent, total, 0, block.timestamp + 60, n1);
        router.settle(appId, SherwoodRouter.Authorization(agent, total, 0, block.timestamp + 60, n1, v, r, s));
        bytes32 n2 = keccak256("a2");
        (v, r, s) = sign(agentKey, agent, total, 0, block.timestamp + 60, n2);
        vm.expectRevert(abi.encodeWithSelector(SherwoodRouter.AppDailyLimit.selector, 10_300, 20_600));
        router.settle(appId, SherwoodRouter.Authorization(agent, total, 0, block.timestamp + 60, n2, v, r, s));
    }

    function testOnlyFacilitator() public {
        (,, uint256 total) = router.quote(appId, agent);
        bytes32 nonce = keccak256("f1");
        (uint8 v, bytes32 r, bytes32 s) = sign(agentKey, agent, total, 0, block.timestamp + 60, nonce);
        vm.prank(address(0xDEAD));
        vm.expectRevert(SherwoodRouter.NotFacilitator.selector);
        router.settle(appId, SherwoodRouter.Authorization(agent, total, 0, block.timestamp + 60, nonce, v, r, s));
    }

    function testStakingDiscountLowersFee() public {
        shos.approve(address(staking), 100_000e18);
        staking.stake(100_000e18);
        (, uint256 fee, uint256 total) = router.quote(appId, agent);
        assertEq(fee, 225);
        assertEq(total, 10_225);
        bytes32 nonce = keccak256("s1");
        (uint8 v, bytes32 r, bytes32 s) = sign(agentKey, agent, total, 0, block.timestamp + 60, nonce);
        router.settle(appId, SherwoodRouter.Authorization(agent, total, 0, block.timestamp + 60, nonce, v, r, s));
        assertEq(IUSDG(USDG).balanceOf(treasury), 225);
        staking.unstake(100_000e18);
        assertEq(shos.balanceOf(address(this)), 1_000_000_000e18);
    }

    function testWrongAmountRejected() public {
        bytes32 nonce = keccak256("w1");
        (uint8 v, bytes32 r, bytes32 s) = sign(agentKey, agent, 10_000, 0, block.timestamp + 60, nonce);
        vm.expectRevert(abi.encodeWithSelector(SherwoodRouter.BadAmount.selector, 10_300, 10_000));
        router.settle(appId, SherwoodRouter.Authorization(agent, 10_000, 0, block.timestamp + 60, nonce, v, r, s));
    }

    function testUnknownAgentHasNoPolicy() public {
        uint256 strangerKey = 0xB0B;
        address stranger = vm.addr(strangerKey);
        fundUSDG(stranger, 1_000_000);
        (,, uint256 total) = router.quote(appId, stranger);
        bytes32 nonce = keccak256("np1");
        (uint8 v, bytes32 r, bytes32 s) = sign(strangerKey, stranger, total, 0, block.timestamp + 60, nonce);
        vm.expectRevert(SherwoodRouter.NoPolicy.selector);
        router.settle(appId, SherwoodRouter.Authorization(stranger, total, 0, block.timestamp + 60, nonce, v, r, s));

        assertEq(IUSDG(USDG).balanceOf(stranger), 1_000_000);
        assertFalse(IUSDG(USDG).authorizationState(stranger, nonce));
    }

    function testInactiveOrUnknownAppRejected() public {
        bytes32 ghost = keccak256("ghost-app");
        bytes32 nonce = keccak256("ia1");
        (uint8 v, bytes32 r, bytes32 s) = sign(agentKey, agent, 10_300, 0, block.timestamp + 60, nonce);
        vm.expectRevert(SherwoodRouter.AppInactive.selector);
        router.settle(ghost, SherwoodRouter.Authorization(agent, 10_300, 0, block.timestamp + 60, nonce, v, r, s));

        router.setApp(appId, "Market Data", provider, 10_000, false);
        vm.expectRevert(SherwoodRouter.AppInactive.selector);
        router.settle(appId, SherwoodRouter.Authorization(agent, 10_300, 0, block.timestamp + 60, nonce, v, r, s));
    }

    function testPerRequestLimitEnforced() public {
        bytes32 big = keccak256("trading");
        router.setApp(big, "Trading", provider, 300_000, true);
        (,, uint256 total) = router.quote(big, agent);
        assertEq(total, 309_000);
        bytes32 nonce = keccak256("pr1");
        (uint8 v, bytes32 r, bytes32 s) = sign(agentKey, agent, total, 0, block.timestamp + 60, nonce);
        vm.expectRevert(abi.encodeWithSelector(SherwoodRouter.PerRequestLimit.selector, 250_000, 309_000));
        router.settle(big, SherwoodRouter.Authorization(agent, total, 0, block.timestamp + 60, nonce, v, r, s));
    }

    function testExpiredAuthorizationRejectedByUSDG() public {
        (,, uint256 total) = router.quote(appId, agent);
        bytes32 nonce = keccak256("ex1");
        uint256 validBefore = block.timestamp - 1;
        (uint8 v, bytes32 r, bytes32 s) = sign(agentKey, agent, total, 0, validBefore, nonce);
        vm.expectRevert();
        router.settle(appId, SherwoodRouter.Authorization(agent, total, 0, validBefore, nonce, v, r, s));
    }

    function testNotYetValidAuthorizationRejectedByUSDG() public {
        (,, uint256 total) = router.quote(appId, agent);
        bytes32 nonce = keccak256("nv1");
        uint256 validAfter = block.timestamp + 3600;
        (uint8 v, bytes32 r, bytes32 s) = sign(agentKey, agent, total, validAfter, block.timestamp + 7200, nonce);
        vm.expectRevert();
        router.settle(appId, SherwoodRouter.Authorization(agent, total, validAfter, block.timestamp + 7200, nonce, v, r, s));
    }

    function testForeignSignatureRejectedByUSDG() public {

        (,, uint256 total) = router.quote(appId, agent);
        bytes32 nonce = keccak256("fs1");
        (uint8 v, bytes32 r, bytes32 s) = sign(0xB0B, agent, total, 0, block.timestamp + 60, nonce);
        vm.expectRevert();
        router.settle(appId, SherwoodRouter.Authorization(agent, total, 0, block.timestamp + 60, nonce, v, r, s));
        assertEq(IUSDG(USDG).balanceOf(agent), 25_000_000);
    }

    function testDailyLimitResetsNextDay() public {
        router.setPolicy(agent, address(this), 10_300, 250_000, true);
        (,, uint256 total) = router.quote(appId, agent);
        bytes32 n1 = keccak256("r1");
        (uint8 v, bytes32 r, bytes32 s) = sign(agentKey, agent, total, 0, block.timestamp + 60, n1);
        router.settle(appId, SherwoodRouter.Authorization(agent, total, 0, block.timestamp + 60, n1, v, r, s));
        assertEq(router.remainingToday(agent), 0);

        bytes32 n2 = keccak256("r2");
        (v, r, s) = sign(agentKey, agent, total, 0, block.timestamp + 60, n2);
        vm.expectRevert(abi.encodeWithSelector(SherwoodRouter.DailyLimit.selector, 10_300, 20_600));
        router.settle(appId, SherwoodRouter.Authorization(agent, total, 0, block.timestamp + 60, n2, v, r, s));

        vm.warp(((block.timestamp / 1 days) + 1) * 1 days + 1);
        assertEq(router.remainingToday(agent), 10_300);
        (v, r, s) = sign(agentKey, agent, total, 0, block.timestamp + 60, n2);
        router.settle(appId, SherwoodRouter.Authorization(agent, total, 0, block.timestamp + 60, n2, v, r, s));
        assertEq(router.receiptCount(), 2);
    }

    function testInsufficientUSDGReverts() public {
        uint256 poorKey = 0xC0DE;
        address poor = vm.addr(poorKey);
        router.setPolicy(poor, address(this), 5_000_000, 250_000, true);
        fundUSDG(poor, 5_000);
        (,, uint256 total) = router.quote(appId, poor);
        bytes32 nonce = keccak256("poor1");
        (uint8 v, bytes32 r, bytes32 s) = sign(poorKey, poor, total, 0, block.timestamp + 60, nonce);
        vm.expectRevert();
        router.settle(appId, SherwoodRouter.Authorization(poor, total, 0, block.timestamp + 60, nonce, v, r, s));
        assertEq(router.receiptCount(), 0);
        assertEq(router.remainingToday(poor), 5_000_000);
    }

    function testZeroFeeSkipsTreasuryTransfer() public {
        router.setTreasury(treasury, 0);
        (, uint256 fee, uint256 total) = router.quote(appId, agent);
        assertEq(fee, 0);
        assertEq(total, 10_000);
        bytes32 nonce = keccak256("zf1");
        (uint8 v, bytes32 r, bytes32 s) = sign(agentKey, agent, total, 0, block.timestamp + 60, nonce);
        router.settle(appId, SherwoodRouter.Authorization(agent, total, 0, block.timestamp + 60, nonce, v, r, s));
        assertEq(IUSDG(USDG).balanceOf(provider), 10_000);
        assertEq(IUSDG(USDG).balanceOf(treasury), 0);
    }

    function testAdminGuards() public {
        vm.startPrank(address(0xDEAD));
        vm.expectRevert(SherwoodRouter.NotOwner.selector);
        router.setApp(appId, "x", provider, 1, true);
        vm.expectRevert(SherwoodRouter.NotOwner.selector);
        router.setPolicy(agent, address(this), 1, 1, true);
        vm.expectRevert(SherwoodRouter.NotOwner.selector);
        router.setFacilitator(address(0xDEAD));
        vm.expectRevert(SherwoodRouter.NotOwner.selector);
        router.setTreasury(address(0xDEAD), 100);
        vm.stopPrank();
        vm.expectRevert(bytes("fee > 20%"));
        router.setTreasury(treasury, 2_001);
        vm.expectRevert(bytes("provider"));
        router.setApp(appId, "x", address(0), 1, true);
        vm.expectRevert(bytes("treasury"));
        router.setTreasury(address(0), 100);
        vm.expectRevert(bytes("facilitator"));
        router.setFacilitator(address(0));
        vm.expectRevert(bytes("owner"));
        router.setOwner(address(0));
    }

    function testConstructorGuards() public {
        vm.expectRevert(bytes("treasury"));
        new SherwoodRouter(USDG, address(staking), address(0), 300);
        vm.expectRevert(bytes("fee > 20%"));
        new SherwoodRouter(USDG, address(staking), treasury, 2_001);
        vm.expectRevert(bytes("usdg"));
        new SherwoodRouter(address(0), address(staking), treasury, 300);
    }

    function testFacilitatorRotation() public {
        address newFacilitator = address(0xFAC);
        router.setFacilitator(newFacilitator);
        (,, uint256 total) = router.quote(appId, agent);
        bytes32 nonce = keccak256("rot1");
        (uint8 v, bytes32 r, bytes32 s) = sign(agentKey, agent, total, 0, block.timestamp + 60, nonce);
        vm.expectRevert(SherwoodRouter.NotFacilitator.selector);
        router.settle(appId, SherwoodRouter.Authorization(agent, total, 0, block.timestamp + 60, nonce, v, r, s));
        vm.prank(newFacilitator);
        router.settle(appId, SherwoodRouter.Authorization(agent, total, 0, block.timestamp + 60, nonce, v, r, s));
        assertEq(router.receiptCount(), 1);
    }

    function testStakingCountsReceivedAmountForTaxedToken() public {
        TaxedToken taxed = new TaxedToken();
        SHOSStaking st = new SHOSStaking(address(taxed), 18);
        taxed.approve(address(st), type(uint256).max);
        st.stake(10_000e18);
        assertEq(st.stakedOf(address(this)), 9_800e18);
        assertEq(st.discountBpsOf(address(this)), 0);
        st.unstake(9_800e18);
        assertEq(st.stakedOf(address(this)), 0);
    }

    function testStakingWorksWithSilentToken() public {
        SilentToken silent = new SilentToken();
        SHOSStaking st = new SHOSStaking(address(silent), 6);
        silent.approve(address(st), type(uint256).max);
        st.stake(10_000e6);
        assertEq(st.discountBpsOf(address(this)), 1_000);
        st.unstake(10_000e6);
        assertEq(silent.balanceOf(address(this)), 1_000_000e6);
    }

    function testStakingGuards() public {
        vm.expectRevert(bytes("stake: zero"));
        staking.stake(0);
        vm.expectRevert(bytes("unstake: amount"));
        staking.unstake(1);
        vm.expectRevert(bytes("SHOS: allowance"));
        staking.stake(1e18);

        shos.approve(address(staking), type(uint256).max);
        staking.stake(9_999e18);
        assertEq(staking.discountBpsOf(address(this)), 0);
        staking.stake(1e18);
        assertEq(staking.discountBpsOf(address(this)), 1_000);
        staking.stake(990_000e18);
        assertEq(staking.discountBpsOf(address(this)), 5_000);
        (, uint256 fee,) = router.quote(appId, agent);
        assertEq(fee, 150);
    }
}

contract TaxedToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    constructor() { balanceOf[msg.sender] = 1_000_000e18; }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; return true; }
    function transfer(address to, uint256 v) external returns (bool) { return _move(msg.sender, to, v); }
    function transferFrom(address from, address to, uint256 v) external returns (bool) {
        allowance[from][msg.sender] -= v;
        return _move(from, to, v);
    }
    function _move(address from, address to, uint256 v) internal returns (bool) {
        balanceOf[from] -= v;
        balanceOf[to] += v - v / 50;
        return true;
    }
}

contract SilentToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    constructor() { balanceOf[msg.sender] = 1_000_000e6; }
    function approve(address s, uint256 v) external { allowance[msg.sender][s] = v; }
    function transfer(address to, uint256 v) external { balanceOf[msg.sender] -= v; balanceOf[to] += v; }
    function transferFrom(address from, address to, uint256 v) external { allowance[from][msg.sender] -= v; balanceOf[from] -= v; balanceOf[to] += v; }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {JBMultiTerminal} from "@bananapus/core-v6/src/JBMultiTerminal.sol";
import {IJBTerminal} from "@bananapus/core-v6/src/interfaces/IJBTerminal.sol";
import {JBConstants} from "@bananapus/core-v6/src/libraries/JBConstants.sol";
import {JBFees} from "@bananapus/core-v6/src/libraries/JBFees.sol";
import {JBRulesetMetadata} from "@bananapus/core-v6/src/structs/JBRulesetMetadata.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {StickyAutoStick} from "../../src/StickyAutoStick.sol";
import {StickyDistributor} from "../../src/StickyDistributor.sol";
import {StickyHook} from "../../src/StickyHook.sol";
import {StickyToken} from "../../src/StickyToken.sol";

import {StickyRealProjectLifecycle} from "./StickyRealProjects.t.sol";
import {StickyJbxDeployedFork} from "./helpers/StickyJbxDeployedFork.sol";

/// @notice The existing lifecycle acceptance checks, now against real JBX and the already-deployed Sticky release.
/// @dev Only fork ETH inputs, caller impersonation, time and block advancement are synthetic. No ERC-20 inventory,
/// runtime or contract storage is replaced. Zero-tax transferable settings are qualified separately below; the
/// inherited scenarios deliberately retain their original zero-tax soulbound and 50%-tax fixture assumptions.
contract StickyJbxLifecycleForkTest is StickyRealProjectLifecycle, StickyJbxDeployedFork {
    uint256 internal constant _JBX_ALLOCATION = 1_000_000 ether;
    uint256 internal constant _JBX_LARGE_HOLDER_STAKE = 50_000_000 ether;
    uint256 internal constant _REWARD_NATIVE_INPUT = 0.01 ether;

    function setUp() public {
        _context = _deployedJbxContext();
        _alice = makeAddr("alice");
        _bob = makeAddr("bob");
        _granter = makeAddr("granter");
        _hook = StickyHook(_context.suite.hook);
        _distributor = StickyDistributor(payable(_context.suite.distributor));
        _autoStick = StickyAutoStick(_context.suite.autoStick);
        (_projectId, _token) = _launchSticky({context: _context, soulbound: true, cashOutTaxRate: 0});
        _transferJbx(_alice, _JBX_ALLOCATION);
        _transferJbx(_bob, _JBX_ALLOCATION);
        _transferJbx(_granter, _JBX_ALLOCATION);
        // Existing positive reward scenarios assume a fresh reward round. The deployed shared distributor may
        // already have frozen current/next snapshots. Model two weeks explicitly rather than clearing its storage.
        uint256 eligibleRound = _distributor.currentRound() + 2;
        assertEq(_distributor.roundSnapshotBlock(eligibleRound), 0, "positive scenario needs an unpinned round");
        vm.warp(_distributor.roundStartTimestamp(eligibleRound));
        vm.roll(vm.getBlockNumber() + 1);
    }

    /// @notice User-provisional settings fix only AutoStick as granter and return all JBX with no cash-out tax.
    function test_jbxZeroTaxTransferableConfigurationAndExactWalletRoundTrip() public {
        _launchJbx(0, false);
        (, JBRulesetMetadata memory metadata) = _context.core.controller.currentRulesetOf(_projectId);
        assertEq(metadata.cashOutTaxRate, 0);
        assertFalse(_token.SOULBOUND());
        assertEq(_token.name(), "Sticky JBX");
        assertEq(_token.symbol(), "STICKYJBX");
        assertTrue(_hook.isGranterOf(_projectId, address(_autoStick)));
        assertFalse(_hook.isGranterOf(_projectId, _granter));
        uint256 beforeBalance = _context.underlying.balanceOf(_alice);
        uint256 shares = _stake(_context, _projectId, _alice, _alice, _JBX_ALLOCATION);
        assertEq(shares, _JBX_ALLOCATION);
        assertEq(_cashOut(_context, _projectId, _alice, shares, _JBX_ALLOCATION), _JBX_ALLOCATION);
        assertEq(_context.underlying.balanceOf(_alice), beforeBalance, "no JBX lost on zero-tax round trip");
        assertEq(_backing(), 0);
        assertEq(_token.totalSupply(), 0);
        _assertPosition(_alice);
    }

    /// @notice A 100-million-JBX position uses real donor inventory and conserves value through two-holder exits.
    function test_jbxHundredMillionTwoHolderRoundTripConservesEveryToken() public {
        _launchJbx(0, false);
        uint256 donorBefore = _context.underlying.balanceOf(_JBX_DONOR);
        uint256 supplyBefore = _context.underlying.totalSupply();
        uint256 terminalBefore = _context.underlying.balanceOf(address(_context.core.terminal));
        _transferJbx(_alice, _JBX_LARGE_HOLDER_STAKE);
        _transferJbx(_bob, _JBX_LARGE_HOLDER_STAKE);
        uint256 aliceBefore = _context.underlying.balanceOf(_alice);
        uint256 bobBefore = _context.underlying.balanceOf(_bob);
        uint256 aliceShares = _stake(_context, _projectId, _alice, _alice, _JBX_LARGE_HOLDER_STAKE);
        uint256 bobShares = _stake(_context, _projectId, _bob, _bob, _JBX_LARGE_HOLDER_STAKE);
        assertEq(aliceShares + bobShares, 2 * _JBX_LARGE_HOLDER_STAKE);
        assertEq(_backing(), 2 * _JBX_LARGE_HOLDER_STAKE);
        assertEq(_context.underlying.balanceOf(address(_context.core.terminal)), terminalBefore + _backing());
        uint256 firstExit = aliceShares / 2;
        assertEq(_cashOut(_context, _projectId, _alice, firstExit, firstExit), firstExit);
        assertEq(_token.balanceOf(_bob), bobShares, "another holder's partial exit retains Bob's shares");
        assertEq(
            _cashOut(_context, _projectId, _alice, aliceShares - firstExit, aliceShares - firstExit),
            aliceShares - firstExit
        );
        assertEq(_backing(), bobShares, "remaining principal belongs exactly to Bob");
        assertEq(_cashOut(_context, _projectId, _bob, bobShares, bobShares), bobShares);
        assertEq(_context.underlying.balanceOf(_alice), aliceBefore);
        assertEq(_context.underlying.balanceOf(_bob), bobBefore);
        assertEq(_context.underlying.balanceOf(_JBX_DONOR), donorBefore - 2 * _JBX_LARGE_HOLDER_STAKE);
        assertEq(_context.underlying.balanceOf(address(_context.core.terminal)), terminalBefore);
        assertEq(_context.underlying.totalSupply(), supplyBefore);
        assertEq(_backing(), 0);
        assertEq(_token.totalSupply(), 0);
        _assertPosition(_alice);
        _assertPosition(_bob);
    }

    /// @notice Both transfer modes retain wallet minimums and exact net receipts at representative and edge taxes.
    function test_jbxTaxAndSoulboundMatrixPreservesMinimumsAndBacking() public {
        uint256[4] memory taxes = [uint256(0), uint256(1000), uint256(2500), uint256(9999)];
        for (uint256 i; i < taxes.length; i++) {
            for (uint256 mode; mode < 2; mode++) {
                _exerciseConfiguration(taxes[i], mode == 1);
            }
        }
    }

    /// @notice A same-block initial stake is not eligible, but its zero-stake pot can recycle next eligible round.
    function test_jbxStartupZeroEligibilityRecoversWithoutWaitingForClaimExpiry() public {
        _launchJbx(0, false);
        uint256 amount = _JBX_ALLOCATION / 10;
        _stake(_context, _projectId, _alice, _alice, amount);
        uint256 emptyRound = _distributor.currentRound();
        _fundReward(IERC20(_JBX), amount);
        assertLt(_distributor.roundSnapshotBlock(emptyRound), vm.getBlockNumber(), "same-block stake excluded");
        assertEq(_token.getPastTotalSupply(_distributor.roundSnapshotBlock(emptyRound)), 0);
        uint256[] memory rounds = new uint256[](1);
        rounds[0] = emptyRound;
        assertEq(_distributor.recycleExpiredRewards(address(_token), 0, IERC20(_JBX), rounds), 0);
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(_distributor.roundStartTimestamp(emptyRound + 1));
        assertEq(_distributor.recycleExpiredRewards(address(_token), 0, IERC20(_JBX), rounds), amount);
        assertEq(_distributor.balanceOf(address(_token), IERC20(_JBX)), amount, "recycle preserves custody");
        assertGe(_distributor.roundSnapshotBlock(emptyRound + 1), vm.getBlockNumber() - 1, "stake now eligible");
        _vestAndCollect(IERC20(_JBX), amount);
        assertEq(_distributor.recycleExpiredRewards(address(_token), 0, IERC20(_JBX), rounds), 0, "no double recycle");
    }

    /// @notice Freshly issued real V6 project 1 tokens can vest and be collected by the JBX staking holder.
    function test_jbxHolderCollectsRealV6ProjectOneRewards() public {
        _exerciseProjectReward(1);
    }

    /// @notice Freshly issued real V6 project 3 REV can vest and be collected by the JBX staking holder.
    function test_jbxHolderCollectsRealV6RevRewards() public {
        _exerciseProjectReward(3);
    }

    function _exerciseConfiguration(uint256 tax, bool soulbound) internal {
        _launchJbx(tax, soulbound);
        uint256 amount = _JBX_ALLOCATION / 100;
        _stake(_context, _projectId, _alice, _alice, amount);
        _stake(_context, _projectId, _bob, _bob, amount);
        if (soulbound) {
            vm.expectRevert(abi.encodeWithSelector(StickyToken.StickyToken_Soulbound.selector, _alice, _bob));
            vm.prank(_alice);
            _token.transfer(_bob, 1);
        } else {
            vm.prank(_alice);
            assertTrue(_token.transfer(_bob, 1));
        }
        _cashOutWithMinimum(_alice, _token.balanceOf(_alice) / 2, tax);
        _cashOutWithMinimum(_alice, _token.balanceOf(_alice), tax);
        _cashOutWithMinimum(_bob, _token.balanceOf(_bob), tax);
        assertEq(_token.totalSupply(), 0);
        assertEq(_backing(), 0, "final holder consumes all non-orphan backing");
        _assertPosition(_alice);
        _assertPosition(_bob);
    }

    function _cashOutWithMinimum(address holder, uint256 count, uint256 expectedTax) internal {
        (, uint256 gross, uint256 actualTax,) = _context.core.terminal.STORE().previewCashOutFrom({
            terminal: address(_context.core.terminal),
            holder: holder,
            projectId: _projectId,
            cashOutCount: count,
            tokenToReclaim: _JBX,
            beneficiaryIsFeeless: false,
            metadata: bytes("")
        });
        assertEq(actualTax, expectedTax);
        uint256 expectedNet = expectedTax == 0 ? gross : gross - JBFees.standardFeeAmountFrom(gross);
        uint256 beforeWallet = _context.underlying.balanceOf(holder);
        uint256 beforeShares = _token.balanceOf(holder);
        vm.expectPartialRevert(JBMultiTerminal.JBMultiTerminal_UnderMin.selector);
        vm.prank(holder);
        _context.core.terminal
            .cashOutTokensOf({
                holder: holder,
                projectId: _projectId,
                cashOutCount: count,
                tokenToReclaim: _JBX,
                minTokensReclaimed: expectedNet + 1,
                beneficiary: payable(holder),
                metadata: bytes("")
            });
        assertEq(_context.underlying.balanceOf(holder), beforeWallet, "failed minimum retains JBX");
        assertEq(_token.balanceOf(holder), beforeShares, "failed minimum retains shares");
        assertEq(_cashOut(_context, _projectId, holder, count, expectedNet), expectedNet);
    }

    function _exerciseProjectReward(uint256 sourceProjectId) internal {
        _launchJbx(0, false);
        _stake(_context, _projectId, _alice, _alice, _JBX_ALLOCATION / 10);
        uint256 stakeBlock = vm.getBlockNumber();
        IERC20 reward = IERC20(address(_context.core.controller.TOKENS().tokenOf(sourceProjectId)));
        assertGt(address(reward).code.length, 0, "existing V6 reward ERC20");
        assertTrue(address(reward) != _JBX, "V6 project 1 is distinct from migrated Ethereum JBX");
        IJBTerminal sourceTerminal =
            _context.core.directory.primaryTerminalOf(sourceProjectId, JBConstants.NATIVE_TOKEN);
        uint256 beforeBalance = reward.balanceOf(_granter);
        // The native payment is test-funded; reward ERC20s still originate exclusively from the deployed project.
        vm.deal(_granter, _REWARD_NATIVE_INPUT);
        vm.prank(_granter);
        uint256 issued = sourceTerminal.pay{value: _REWARD_NATIVE_INPUT}({
            projectId: sourceProjectId,
            token: JBConstants.NATIVE_TOKEN,
            amount: _REWARD_NATIVE_INPUT,
            beneficiary: _granter,
            minReturnedTokens: 1,
            memo: "Sticky JBX fork reward",
            metadata: bytes("")
        });
        assertGt(issued, 0);
        assertEq(reward.balanceOf(_granter) - beforeBalance, issued, "real reward issuance wallet delta");
        vm.roll(vm.getBlockNumber() + 1);
        _fundReward(reward, issued);
        assertGe(
            _distributor.roundSnapshotBlock(_distributor.currentRound()), stakeBlock, "reward snapshot includes stake"
        );
        _vestAndCollect(reward, issued);
    }

    function _fundReward(IERC20 reward, uint256 amount) internal {
        vm.startPrank(_granter);
        assertTrue(reward.approve(address(_distributor), amount));
        _distributor.fund(address(_token), reward, amount, 0);
        vm.stopPrank();
    }

    function _launchJbx(uint256 tax, bool soulbound) internal {
        (_projectId, _token) = _launchDeployedJbx(_context, tax, soulbound);
    }

    function _vestAndCollect(IERC20 reward, uint256 amount) internal {
        IERC20[] memory rewards = new IERC20[](1);
        rewards[0] = reward;
        vm.warp(_distributor.roundStartTimestamp(_distributor.currentRound() + 1));
        vm.roll(vm.getBlockNumber() + 1);
        _distributor.beginVesting(address(_token), 0, _ids(_alice), rewards);
        assertEq(
            _distributor.collectableFor(address(_token), 0, uint256(uint160(_alice)), reward),
            0,
            "vesting starts locked"
        );
        vm.warp(_distributor.roundStartTimestamp(_distributor.currentRound() + _distributor.VESTING_ROUNDS() + 1));
        vm.roll(vm.getBlockNumber() + 1);
        assertEq(_distributor.collectableFor(address(_token), 0, uint256(uint160(_alice)), reward), amount);
        uint256 beforeBalance = reward.balanceOf(_alice);
        _distributor.collectVestedRewards(address(_token), 0, _ids(_alice), rewards, _alice);
        assertEq(reward.balanceOf(_alice) - beforeBalance, amount, "real reward reaches JBX staker wallet");
        assertEq(_distributor.balanceOf(address(_token), reward), 0, "reward inventory conserved");
        _distributor.collectVestedRewards(address(_token), 0, _ids(_alice), rewards, _alice);
        assertEq(reward.balanceOf(_alice), beforeBalance + amount, "no repeated collection");
    }
}

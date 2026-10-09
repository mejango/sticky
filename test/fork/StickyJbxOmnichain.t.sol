// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IJBController} from "@bananapus/core-v6/src/interfaces/IJBController.sol";
import {IJBMultiTerminal} from "@bananapus/core-v6/src/interfaces/IJBMultiTerminal.sol";
import {IJBTerminal} from "@bananapus/core-v6/src/interfaces/IJBTerminal.sol";
import {IJBSplitHook} from "@bananapus/core-v6/src/interfaces/IJBSplitHook.sol";
import {JBConstants} from "@bananapus/core-v6/src/libraries/JBConstants.sol";
import {JBAccountingContext} from "@bananapus/core-v6/src/structs/JBAccountingContext.sol";
import {JBRuleset} from "@bananapus/core-v6/src/structs/JBRuleset.sol";
import {JBRulesetConfig} from "@bananapus/core-v6/src/structs/JBRulesetConfig.sol";
import {JBRulesetMetadata} from "@bananapus/core-v6/src/structs/JBRulesetMetadata.sol";
import {JBSplit} from "@bananapus/core-v6/src/structs/JBSplit.sol";
import {JBSplitGroup} from "@bananapus/core-v6/src/structs/JBSplitGroup.sol";
import {JBTerminalConfig} from "@bananapus/core-v6/src/structs/JBTerminalConfig.sol";
import {JBArbitrumSucker} from "@bananapus/suckers-v6/src/JBArbitrumSucker.sol";
import {JBOptimismSucker} from "@bananapus/suckers-v6/src/JBOptimismSucker.sol";
import {JBSucker} from "@bananapus/suckers-v6/src/JBSucker.sol";
import {IJBSuckerDeployer} from "@bananapus/suckers-v6/src/interfaces/IJBSuckerDeployer.sol";
import {IJBSuckerRegistry} from "@bananapus/suckers-v6/src/interfaces/IJBSuckerRegistry.sol";
import {JBClaim} from "@bananapus/suckers-v6/src/structs/JBClaim.sol";
import {JBLeaf} from "@bananapus/suckers-v6/src/structs/JBLeaf.sol";
import {JBMessageRoot} from "@bananapus/suckers-v6/src/structs/JBMessageRoot.sol";
import {JBOutboxTree} from "@bananapus/suckers-v6/src/structs/JBOutboxTree.sol";
import {JBSuckerDeployerConfig} from "@bananapus/suckers-v6/src/structs/JBSuckerDeployerConfig.sol";
import {JBTokenMapping} from "@bananapus/suckers-v6/src/structs/JBTokenMapping.sol";
import {MerkleLib} from "@bananapus/suckers-v6/src/utils/MerkleLib.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Bytes} from "@openzeppelin/contracts/utils/Bytes.sol";
import {Vm} from "forge-std/Vm.sol";

import {StickyDistributor} from "../../src/StickyDistributor.sol";
import {StickyRewardReceiverFactory} from "../../src/StickyRewardReceiverFactory.sol";
import {StickySourceCollector} from "../../src/StickySourceCollector.sol";
import {StickySourceFeePayer} from "../../src/StickySourceFeePayer.sol";
import {StickyToken} from "../../src/StickyToken.sol";
import {StickyCoreDeployment} from "../../script/structs/StickyCoreDeployment.sol";
import {StickyDeploymentAddresses} from "../../script/structs/StickyDeploymentAddresses.sol";
import {StickyDeploymentHarness} from "../deployment/StickyDeploymentHarness.sol";
import {StickyJbxDeployedFork} from "./helpers/StickyJbxDeployedFork.sol";
import {StickyJbxArbitrumTransport} from "./helpers/StickyJbxArbitrumTransport.sol";
import {StickyJbxOptimismTransport} from "./helpers/StickyJbxOptimismTransport.sol";
import {StickyRealProjectContext} from "./helpers/StickyRealProjectFork.sol";

/// @notice Qualifies deployed V6 reserved rewards reaching a real-JBX Sticky position on Ethereum.
/// @dev Local split edits and source Safe calls model authorized setup/custody, not Safe signer consent. Remote
/// routes are deliberately named manualCustodian: the current reserved split pays a Safe, which must approve and
/// prepare the bridge. Send, claim, receiver settlement, vesting and holder-directed collection are permissionless.
/// Finalized messenger context is modeled; test ETH funds real terminal payments and fees. No reward token,
/// project backing storage, bridge escrow, or deployed code is fabricated. These tests do not establish withdrawal
/// consensus/finality, a production collector deployment, or a live relayer service. Collector cases deploy the
/// local implementation on each pinned fork and require no privileged caller after split configuration. The generic
/// positive ERC-20 case supplies bounded USDC.e input through `deal`, then executes actual payment and bridge burning;
/// it qualifies source submission only and makes no claim about counterpart setup or ERC-20 withdrawal finalization.
contract StickyJbxOmnichainForkTest is StickyJbxDeployedFork, StickyJbxArbitrumTransport, StickyJbxOptimismTransport {
    /// @notice The pinned source contracts and actual reserved-token custodian.
    struct Source {
        uint256 forkId;
        uint256 projectId;
        uint256 rulesetId;
        IJBController controller;
        IJBTerminal terminal;
        IERC20 token;
        JBSucker sucker;
        address custodian;
    }

    /// @notice The nonindexed fields emitted by the real sucker for the collector's appended leaf.
    struct InsertedLeaf {
        bytes32 hashed;
        uint256 index;
        bytes32 root;
        uint256 projectTokenCount;
        uint256 terminalTokenAmount;
        bytes32 metadata;
        address caller;
    }

    uint256 internal constant _REV_RESERVED_REWARD_PERCENT = 263_157_895;

    /// @notice The Ethereum USDC counterpart selected for generic six-decimal backing routes.
    address internal constant _ETHEREUM_USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    /// @notice The canonical OP bridged USDC used to exercise real ERC-20 cashout and source transport.
    address internal constant _OP_USDCE = 0x7F5c764cBc14f9669B88837ca1490cCa17c31607;

    bytes32 internal constant _INSERTED_LEAF =
        keccak256("InsertToOutboxTree(bytes32,address,bytes32,uint256,bytes32,uint256,uint256,bytes32,address)");
    bytes32 internal constant _TOKEN_TRANSFER = keccak256("Transfer(address,address,uint256)");

    uint256 internal constant _NATIVE_INPUT = 0.01 ether;
    uint256 internal constant _STAKE = 1_000_000 ether;
    uint256 internal constant _REV_PROJECT = 3;
    uint256 internal constant _OPTIMISM = 10;
    uint256 internal constant _BASE = 8453;
    uint256 internal constant _SELECTOR_BYTES = 4;
    uint256 internal constant _ARBITRUM = 42_161;
    uint256 internal constant _RESERVED_GROUP = 1;
    uint256 internal constant _MERKLE_DEPTH = 32;

    StickyRealProjectContext internal _ethereum;
    StickyToken internal _sticky;
    StickyDistributor internal _distributor;
    uint256 internal _stickyProjectId;
    address internal _receiver;
    address internal _holder;
    address internal _payer;
    address internal _keeper;
    string internal _inventory;

    /// @notice Launches only a fork-local project through the existing deployed suite, backed by actual donor JBX.
    function setUp() public {
        _ethereum = _deployedJbxContext();
        // The committed census is read-only qualification input.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        _inventory = vm.readFile("test/fork/fixtures/sticky-jbx-sources.json");
        _holder = makeAddr("omnichain JBX holder");
        _payer = makeAddr("omnichain real terminal payer");
        _keeper = makeAddr("omnichain unrelated keeper");
        (_stickyProjectId, _sticky) = _launchDeployedJbx(_ethereum, 0, false);
        _distributor = StickyDistributor(payable(_ethereum.suite.distributor));
        _transferJbx(_holder, _STAKE);
        _stake(_ethereum, _stickyProjectId, _holder, _holder, _STAKE);
        vm.roll(vm.getBlockNumber() + 1);
        // Existing shared-distributor snapshots must not be rewritten. Start at an unpinned future reward round.
        uint256 eligibleRound = _distributor.currentRound() + 2;
        assertEq(_distributor.roundSnapshotBlock(eligibleRound), 0, "fresh snapshot after JBX stake");
        vm.warp(_distributor.roundStartTimestamp(eligibleRound));
        vm.roll(vm.getBlockNumber() + 1);
        _receiver =
            StickyRewardReceiverFactory(_ethereum.suite.rewardReceiverFactory).predictReceiverOf(address(_sticky), 0);
        assertEq(_receiver.code.length, 0, "counterfactual receiver");
        assertFalse(_sticky.SOULBOUND(), "user-provisional transferable shares");
    }

    /// @notice Actual Ethereum project 1 reserves enter the shared hook before permissionless settlement.
    function test_ethereumProjectOne_reservedSplitHookToJbxHolder() public {
        _localReserved(1);
    }

    /// @notice Actual Ethereum project 3 reserves enter the shared hook before permissionless settlement.
    function test_ethereumProjectThree_reservedSplitHookToJbxHolder() public {
        _localReserved(_REV_PROJECT);
    }

    /// @notice OP project 1's current Safe-held reserves can bridge and permissionlessly reach the JBX holder.
    function test_optimismProjectOne_manualCustodianToEthereumJbx() public {
        _remoteReserved(_OPTIMISM, 1);
    }

    /// @notice OP project 3's current Safe-held reserves can bridge and permissionlessly reach the JBX holder.
    function test_optimismProjectThree_manualCustodianToEthereumJbx() public {
        _remoteReserved(_OPTIMISM, _REV_PROJECT);
    }

    /// @notice Base project 1's current Safe-held reserves can bridge and permissionlessly reach the JBX holder.
    function test_baseProjectOne_manualCustodianToEthereumJbx() public {
        _remoteReserved(_BASE, 1);
    }

    /// @notice Base project 3's current Safe-held reserves can bridge and permissionlessly reach the JBX holder.
    function test_baseProjectThree_manualCustodianToEthereumJbx() public {
        _remoteReserved(_BASE, _REV_PROJECT);
    }

    /// @notice Arbitrum project 1's current Safe-held reserves can bridge and permissionlessly reach the JBX holder.
    function test_arbitrumProjectOne_manualCustodianToEthereumJbx() public {
        _remoteReserved(_ARBITRUM, 1);
    }

    /// @notice Arbitrum project 3's current Safe-held reserves can bridge and permissionlessly reach the JBX holder.
    function test_arbitrumProjectThree_manualCustodianToEthereumJbx() public {
        _remoteReserved(_ARBITRUM, _REV_PROJECT);
    }

    /// @notice An unrelated caller distributes and sends OP JBP6 reserves after a fork-only full-reserve setup.
    function test_optimismProjectOne_permissionlessSplitHookToEthereumJbx() public {
        _remoteCollected(_OPTIMISM, 1);
    }

    /// @notice An unrelated caller sends OP REV's approved reward fraction while preserving the Safe remainder.
    function test_optimismProjectThree_permissionlessSplitHookToEthereumJbx() public {
        _remoteCollected(_OPTIMISM, _REV_PROJECT);
    }

    /// @notice An unrelated caller distributes and sends Base JBP6 reserves after a fork-only full-reserve setup.
    function test_baseProjectOne_permissionlessSplitHookToEthereumJbx() public {
        _remoteCollected(_BASE, 1);
    }

    /// @notice An unrelated caller sends Base REV's approved reward fraction while preserving the Safe remainder.
    function test_baseProjectThree_permissionlessSplitHookToEthereumJbx() public {
        _remoteCollected(_BASE, _REV_PROJECT);
    }

    /// @notice An unrelated caller distributes and sends Arbitrum JBP6 reserves after a fork-only full-reserve setup.
    function test_arbitrumProjectOne_permissionlessSplitHookToEthereumJbx() public {
        _remoteCollected(_ARBITRUM, 1);
    }

    /// @notice An unrelated caller sends Arbitrum REV's approved reward fraction while preserving the Safe remainder.
    function test_arbitrumProjectThree_permissionlessSplitHookToEthereumJbx() public {
        _remoteCollected(_ARBITRUM, _REV_PROJECT);
    }

    /// @notice Six-decimal backing is paid, cashed out and burned by the deployed canonical OP standard bridge.
    /// @dev Only initial test USDC.e inventory is supplied by `deal`; actual core and bridge accounting execute.
    function test_genericProject_positiveErc20BackingPermissionlessSplitHook() public {
        _genericCollected(_OP_USDCE, 123_456_789);
    }

    /// @notice A selected ERC-20 mapping can submit zero-backed project tokens without confusing ETH fee units.
    function test_genericProject_zeroErc20BackingPermissionlessSplitHook() public {
        _genericCollected(_OP_USDCE, 0);
    }

    /// @notice An ordinary project with no backing can deliver its reserved token count through a native route.
    function test_genericProject_zeroNativeBackingPermissionlessSplitHook() public {
        _genericCollected(JBConstants.NATIVE_TOKEN, 0);
    }

    /// @notice A Base-home queue on OP cannot use its Ethereum peer or borrow custody from the Ethereum-home hook.
    /// @dev Identical share-token address bytes deliberately distinguish the family namespace from destination
    /// readiness; this test neither asserts a Base pool exists at that address nor invents an OP-to-Base route.
    function test_optimismToBase_rejectsEthereumPeerAndKeepsFamiliesSeparate() public {
        Source memory source = _source({chainId: _OPTIMISM, projectId: 1});
        _flushReserved(source);
        StickySourceCollector baseFamily = _deployCollector({source: source, destinationChainId: _BASE});
        StickySourceCollector ethereumFamily = _deployCollector({source: source, destinationChainId: 1});
        uint256 reward = _fundCollector({source: source, collector: baseFamily});
        assertNotEq(address(baseFamily), address(ethereumFamily));
        assertEq(ethereumFamily.pendingOf(source.projectId, address(_sticky), 0), 0, "another family has no liability");
        assertEq(source.token.balanceOf(address(ethereumFamily)), 0, "another family has no custody");
        JBOutboxTree memory beforeOutbox = source.sucker.outboxOf(JBConstants.NATIVE_TOKEN);
        uint256 fee = source.sucker.REGISTRY().toRemoteFee();
        vm.deal(_keeper, fee);
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_InvalidRoute.selector, source.projectId, source.sucker
            )
        );
        vm.prank(_keeper);
        // An Ethereum peer cannot stand in for the queued Base destination, even though the route is registered.
        // forge-lint: disable-next-item(arbitrary-send-eth)
        baseFamily.send{value: fee}({
            sourceProjectId: source.projectId,
            stickyToken: address(_sticky),
            groupId: 0,
            amount: reward,
            sucker: source.sucker,
            backingToken: JBConstants.NATIVE_TOKEN
        });
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_InsufficientPending.selector,
                source.projectId,
                address(_sticky),
                0,
                reward,
                0
            )
        );
        vm.prank(_keeper);
        // The correct Ethereum route still cannot spend an allocation accepted by the Base-home family.
        // forge-lint: disable-next-item(arbitrary-send-eth)
        ethereumFamily.send{value: fee}({
            sourceProjectId: source.projectId,
            stickyToken: address(_sticky),
            groupId: 0,
            amount: reward,
            sucker: source.sucker,
            backingToken: JBConstants.NATIVE_TOKEN
        });
        assertEq(baseFamily.pendingOf(source.projectId, address(_sticky), 0), reward, "destination remains queued");
        assertEq(baseFamily.totalPendingOf(source.projectId), reward, "aggregate liability remains backed");
        assertEq(source.token.balanceOf(address(baseFamily)), reward, "no custody crosses families");
        assertEq(source.token.allowance(address(baseFamily), address(source.sucker)), 0);
        assertEq(abi.encode(source.sucker.outboxOf(JBConstants.NATIVE_TOKEN)), abi.encode(beforeOutbox));
    }

    /// @notice Local emergency exit remints to the remote-beneficiary address, not the preparing Safe.
    /// @dev This demonstrates the existing recovery constraint of an Ethereum-only receiver destination.
    function test_unsentEmergencyExitCreditsReceiverAddressOnSource_notCustodian() public {
        Source memory source = _source(_OPTIMISM, 1);
        JBClaim memory claimData = _prepareReserved(source);
        uint256 custodianBefore = source.token.balanceOf(source.custodian);
        uint256 receiverBefore = source.token.balanceOf(_receiver);
        uint256 supplyBefore = source.token.totalSupply();
        uint256 backingBefore = _backing(source);
        address[] memory tokens = new address[](1);
        tokens[0] = JBConstants.NATIVE_TOKEN;
        // Only the actual project owner can authorize the safety transition in this bounded local simulation.
        vm.prank(source.controller.PROJECTS().ownerOf(source.projectId));
        source.sucker.enableEmergencyHatchFor(tokens);
        vm.prank(_keeper);
        source.sucker.exitThroughEmergencyHatch(claimData);
        assertEq(source.token.balanceOf(source.custodian), custodianBefore, "custodian does not receive recovery");
        assertEq(source.token.balanceOf(_receiver), receiverBefore + claimData.leaf.projectTokenCount);
        assertEq(source.token.totalSupply(), supplyBefore + claimData.leaf.projectTokenCount);
        assertEq(_backing(source), backingBefore + claimData.leaf.terminalTokenAmount);
        assertEq(_receiver.code.length, 0, "Ethereum-only receiver has no source-chain recovery code");
        vm.expectPartialRevert(JBSucker.JBSucker_LeafAlreadyExecuted.selector);
        source.sucker.exitThroughEmergencyHatch(claimData);
    }

    /// @notice A Base-home family has the same identity on four sources and differs from the Ethereum-home family.
    function test_sameBaseHomeSplitHookAddressOnAllFourChains() public {
        _assertCollectorFamilyParity(_BASE);
    }

    /// @notice The Ethereum-home family has the same identity on all four qualified source chains.
    function test_sameSplitHookAndReceiverAddressOnAllFourChains() public {
        _assertCollectorFamilyParity(1);
    }

    /// @notice A dispatched leaf cannot recover locally and later mint again on Ethereum.
    function test_sentReservedLeafCannotExitLocally() public {
        Source memory source = _source(_OPTIMISM, _REV_PROJECT);
        JBClaim memory claimData = _prepareReserved(source);
        _sendOp(source);
        address[] memory tokens = new address[](1);
        tokens[0] = JBConstants.NATIVE_TOKEN;
        vm.prank(source.controller.PROJECTS().ownerOf(source.projectId));
        source.sucker.enableEmergencyHatchFor(tokens);
        vm.expectPartialRevert(JBSucker.JBSucker_LeafAlreadyExecuted.selector);
        source.sucker.exitThroughEmergencyHatch(claimData);
    }

    /// @notice Uses the same shared reserved hook and receiver settlement path on the destination chain.
    /// @param projectId The deployed Ethereum reward project issuing the reserved allocation.
    function _localReserved(uint256 projectId) internal {
        Source memory source = _source(1, projectId);
        _flushReserved(source);
        StickySourceCollector collector = _deployCollector({source: source, destinationChainId: 1});
        uint256 distributorBefore = source.token.balanceOf(address(_distributor));
        uint256 reward = _fundCollector(source, collector);
        assertEq(source.token.balanceOf(address(_distributor)), distributorBefore, "acceptance only queues custody");
        assertEq(source.token.balanceOf(_receiver), 0, "acceptance does not transfer to the receiver");
        vm.prank(_keeper);
        collector.settle({sourceProjectId: projectId, stickyToken: address(_sticky), groupId: 0, amount: reward});
        assertEq(collector.pendingOf(projectId, address(_sticky), 0), 0, "the selected destination bucket settles");
        assertEq(collector.totalPendingOf(projectId), 0, "no outstanding liability after local delivery");
        assertEq(source.token.balanceOf(address(collector)), 0);
        assertEq(source.token.balanceOf(_receiver), 0, "receiver immediately funds the existing distributor");
        assertEq(
            source.token.balanceOf(address(_distributor)), distributorBefore + reward, "settlement funds holder rewards"
        );
        assertEq(source.controller.pendingReservedTokenBalanceOf(projectId), 0);
        _vestCollectAndRedeem(source.token, reward);
    }

    /// @notice Configures only the initial fork split, then uses unrelated callers throughout recurring delivery.
    /// @param chainId The remote source chain whose real route delivers to Ethereum.
    /// @param projectId The deployed source reward project issuing the reserved allocation.
    function _remoteCollected(uint256 chainId, uint256 projectId) internal {
        Source memory source = _source(chainId, projectId);
        _flushReserved(source);
        StickySourceCollector collector = _deployCollector({source: source, destinationChainId: 1});
        JBOutboxTree memory beforeAcceptance = source.sucker.outboxOf(JBConstants.NATIVE_TOKEN);
        uint256 reward = _fundCollector(source, collector);
        JBOutboxTree memory beforeOutbox = source.sucker.outboxOf(JBConstants.NATIVE_TOKEN);
        assertEq(abi.encode(beforeOutbox), abi.encode(beforeAcceptance), "reserved callback only accepts custody");
        uint256 supplyBefore = source.token.totalSupply();
        uint256 nativeBefore = address(source.sucker).balance;
        uint256 callerFeeTokensBefore = _feeToken(source).balanceOf(_keeper);
        uint256 fee = source.sucker.REGISTRY().toRemoteFee();
        assertGt(fee, 0, "pinned registry requires a fee");
        vm.deal(_keeper, fee);
        vm.expectRevert(
            abi.encodeWithSelector(StickySourceFeePayer.StickySourceFeePayer_InsufficientFee.selector, fee - 1, fee)
        );
        vm.prank(_keeper);
        // This local deployment receives deliberately insufficient caller funds; all custody must roll back.
        // forge-lint: disable-next-item(arbitrary-send-eth)
        collector.send{value: fee - 1}({
            sourceProjectId: projectId,
            stickyToken: address(_sticky),
            groupId: 0,
            amount: reward,
            sucker: source.sucker,
            backingToken: JBConstants.NATIVE_TOKEN
        });
        assertEq(source.token.balanceOf(address(collector)), reward, "bad fee preserves all reserved principal");
        assertEq(collector.pendingOf(projectId, address(_sticky), 0), reward, "failed send preserves attribution");
        assertEq(collector.totalPendingOf(projectId), reward, "failed send preserves aggregate liabilities");
        assertEq(abi.encode(source.sucker.outboxOf(JBConstants.NATIVE_TOKEN)), abi.encode(beforeOutbox));
        vm.deal(_keeper, fee);
        vm.recordLogs();
        if (chainId == _ARBITRUM) _startArbitrumMessageCapture();
        vm.prank(_keeper);
        // The unrelated keeper supplies only the exact live registry fee, never source tokens or an approval.
        // forge-lint: disable-next-item(arbitrary-send-eth)
        uint256 index = collector.send{value: fee}({
            sourceProjectId: projectId,
            stickyToken: address(_sticky),
            groupId: 0,
            amount: reward,
            sucker: source.sucker,
            backingToken: JBConstants.NATIVE_TOKEN
        });
        ArbitrumMessage memory arbMessage;
        if (chainId == _ARBITRUM) {
            arbMessage = _finishArbitrumMessageCapture(JBArbitrumSucker(payable(address(source.sucker))));
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        JBClaim memory claimData = _collectorClaim({
            logs: logs,
            source: source,
            collector: collector,
            beforeOutbox: beforeOutbox,
            reward: reward,
            backingToken: JBConstants.NATIVE_TOKEN
        });
        assertGt(claimData.leaf.terminalTokenAmount, 0, "existing reward projects reclaim real native backing");
        assertEq(index, claimData.leaf.index);
        _assertCollectorTokenConservation(logs, source, collector, reward, supplyBefore, callerFeeTokensBefore);
        assertEq(
            address(source.sucker).balance,
            nativeBefore - beforeOutbox.balance,
            "fresh backing and prior outbox leave actual source escrow exactly once"
        );
        assertEq(source.sucker.outboxOf(JBConstants.NATIVE_TOKEN).tree.count, beforeOutbox.tree.count + 1);
        uint256 value = beforeOutbox.balance + claimData.leaf.terminalTokenAmount;
        OpMessage memory opMessage;
        if (chainId == _ARBITRUM) assertEq(arbMessage.value, value, "complete actual native outbox submitted");
        else opMessage = _captureOpMessage(logs, JBOptimismSucker(payable(address(source.sucker))), value);
        _completeRemote(source, chainId, claimData, arbMessage, opMessage);
    }

    /// @notice Routes the approved fraction through the actual controller and accounts for every minted reserve atom.
    /// @param source The deployed source project and authorized split custodian.
    /// @param collector The shared hook accepting the selected Sticky reward allocation.
    /// @return reward The actual project-token atoms attributed to the selected Sticky pool.
    function _fundCollector(Source memory source, StickySourceCollector collector) internal returns (uint256 reward) {
        uint256 percent =
            source.projectId == _REV_PROJECT ? _REV_RESERVED_REWARD_PERCENT : JBConstants.SPLITS_TOTAL_PERCENT;
        JBSplit[] memory splits = new JBSplit[](percent == JBConstants.SPLITS_TOTAL_PERCENT ? 1 : 2);
        // Both split percentages are bounded by the protocol's 1e9 denominator, below uint32 max.
        // forge-lint: disable-next-item(unsafe-typecast)
        splits[0] = JBSplit({
            percent: uint32(percent),
            projectId: 0,
            beneficiary: payable(address(_sticky)),
            preferAddToBalance: false,
            lockedUntil: 0,
            hook: IJBSplitHook(address(collector))
        });
        if (splits.length > 1) {
            // forge-lint: disable-next-item(unsafe-typecast)
            splits[1] = JBSplit({
                percent: uint32(JBConstants.SPLITS_TOTAL_PERCENT - percent),
                projectId: 0,
                beneficiary: payable(source.custodian),
                preferAddToBalance: false,
                lockedUntil: 0,
                hook: IJBSplitHook(address(0))
            });
        }
        JBSplitGroup[] memory groups = new JBSplitGroup[](1);
        groups[0] = JBSplitGroup({groupId: _RESERVED_GROUP, splits: splits});
        // This is the sole privileged setup operation. Production configuration requires the real Safe's consent.
        vm.prank(source.custodian);
        source.controller.setSplitGroupsOf(source.projectId, source.rulesetId, groups);
        uint256 total = _issueReserved(source);
        address owner = source.controller.PROJECTS().ownerOf(source.projectId);
        assertNotEq(_keeper, source.custodian);
        assertNotEq(_keeper, owner);
        uint256 safeBefore = source.token.balanceOf(source.custodian);
        uint256 ownerBefore = source.token.balanceOf(owner);
        uint256 supplyBefore = source.token.totalSupply();
        assertEq(source.token.balanceOf(address(collector)), 0);
        vm.prank(_keeper);
        assertEq(source.controller.sendReservedTokensToSplitsOf(source.projectId), total);
        reward = Math.mulDiv(total, percent, JBConstants.SPLITS_TOTAL_PERCENT);
        uint256 safeShare =
            Math.mulDiv(total, JBConstants.SPLITS_TOTAL_PERCENT - percent, JBConstants.SPLITS_TOTAL_PERCENT);
        uint256 ownerDust = total - reward - safeShare;
        assertGt(reward, 0);
        assertEq(source.token.balanceOf(address(collector)), reward, "actual reserved share reaches collector");
        assertEq(
            collector.pendingOf(source.projectId, address(_sticky), 0), reward, "hook credits only its destination"
        );
        assertEq(collector.totalPendingOf(source.projectId), reward, "aggregate debt equals accepted real reserves");
        assertEq(
            source.token.allowance(address(source.controller), address(collector)), 0, "controller clears approval"
        );
        assertEq(
            source.token.balanceOf(source.custodian), safeBefore + safeShare, "Safe keeps exact unallocated remainder"
        );
        assertEq(
            source.token.balanceOf(owner), ownerBefore + ownerDust, "controller rounding dust reaches actual owner"
        );
        assertEq(source.token.totalSupply(), supplyBefore + total, "all reserved minting conserved");
        assertEq(source.controller.pendingReservedTokenBalanceOf(source.projectId), 0);
        assertEq(source.token.balanceOf(_keeper), 0, "distribution grants no rewards to its caller");
    }

    /// @notice Derives the claim only from the actual sucker's emitted leaf and the pre-send tree frontier.
    /// @param logs The actual source logs emitted during preparation and submission.
    /// @param source The source project and registered sucker responsible for the leaf.
    /// @param collector The shared hook whose custody was prepared.
    /// @param beforeOutbox The selected backing asset's Merkle frontier before preparation.
    /// @param reward The attributed project-token amount selected for delivery.
    /// @param backingToken The selected local backing token or native-token sentinel.
    /// @return claimData The emitted leaf and proof against the resulting source root.
    function _collectorClaim(
        Vm.Log[] memory logs,
        Source memory source,
        StickySourceCollector collector,
        JBOutboxTree memory beforeOutbox,
        uint256 reward,
        address backingToken
    )
        internal
        view
        returns (JBClaim memory claimData)
    {
        uint256 count = 0;
        for (uint256 i = 0; i < logs.length; ++i) {
            Vm.Log memory entry = logs[i];
            if (
                entry.emitter != address(source.sucker) || entry.topics.length == 0 || entry.topics[0] != _INSERTED_LEAF
            ) continue;
            assertEq(entry.topics.length, 3);
            assertEq(entry.topics[1], bytes32(uint256(uint160(_receiver))));
            assertEq(entry.topics[2], bytes32(uint256(uint160(backingToken))));
            InsertedLeaf memory inserted = abi.decode(entry.data, (InsertedLeaf));
            assertEq(inserted.caller, address(collector), "collector itself prepared the source leaf");
            assertEq(inserted.index, beforeOutbox.tree.count);
            assertEq(inserted.projectTokenCount, reward);
            assertEq(inserted.metadata, bytes32(0), "fixed collector leaf attribution");
            JBLeaf memory leaf = JBLeaf({
                index: inserted.index,
                beneficiary: entry.topics[1],
                projectTokenCount: reward,
                terminalTokenAmount: inserted.terminalTokenAmount,
                metadata: inserted.metadata
            });
            claimData = _claimAgainstFrontier(leaf, beforeOutbox);
            claimData.token = backingToken;
            assertEq(
                inserted.hashed,
                keccak256(abi.encode(reward, leaf.terminalTokenAmount, leaf.beneficiary, leaf.metadata))
            );
            assertEq(inserted.root, MerkleLib.branchRoot(inserted.hashed, claimData.proof, leaf.index));
            ++count;
        }
        assertEq(count, 1, "exactly one actual collector leaf");
    }

    /// @notice Separates principal burn from actual fee-related minting on project 1, without a synthetic supply model.
    /// @param logs The actual source logs emitted during preparation and submission.
    /// @param source The source project and registered delivery route.
    /// @param collector The shared hook whose principal and liabilities must remain backed.
    /// @param reward The selected project-token principal burned during preparation.
    /// @param supplyBefore The source ERC-20 supply immediately before submission.
    /// @param callerFeeTokensBefore The delivery caller's fee-token balance before submission.
    function _assertCollectorTokenConservation(
        Vm.Log[] memory logs,
        Source memory source,
        StickySourceCollector collector,
        uint256 reward,
        uint256 supplyBefore,
        uint256 callerFeeTokensBefore
    )
        internal
        view
    {
        uint256 minted = 0;
        uint256 burned = 0;
        uint256 feeReceipt = 0;
        IERC20 feeToken = _feeToken(source);
        address feePayer = address(collector.FEE_PAYER());
        for (uint256 i = 0; i < logs.length; ++i) {
            Vm.Log memory entry = logs[i];
            if (
                entry.emitter == address(feeToken) && entry.topics.length == 3 && entry.topics[0] == _TOKEN_TRANSFER
                    && entry.topics[1] == bytes32(uint256(uint160(feePayer)))
                    && entry.topics[2] == bytes32(uint256(uint160(_keeper)))
            ) {
                feeReceipt += abi.decode(entry.data, (uint256));
            }

            if (
                entry.emitter != address(source.token) || entry.topics.length != 3 || entry.topics[0] != _TOKEN_TRANSFER
            ) continue;
            uint256 amount = abi.decode(entry.data, (uint256));
            if (entry.topics[1] == bytes32(0)) minted += amount;
            if (entry.topics[2] == bytes32(0)) burned += amount;
        }
        assertEq(
            feeToken.balanceOf(_keeper),
            callerFeeTokensBefore + feeReceipt,
            "exact fee receipt reaches the current source caller"
        );
        assertEq(burned, reward, "exact reserved principal burned by the actual token");
        assertEq(source.token.totalSupply(), supplyBefore + minted - burned, "fee minting cannot mask principal burn");
        assertEq(
            source.token.balanceOf(address(collector)),
            collector.pendingOf(source.projectId, address(_sticky), 0),
            "any callback reserves remain attributed instead of becoming caller fee receipts"
        );
        assertEq(
            collector.totalPendingOf(source.projectId),
            collector.pendingOf(source.projectId, address(_sticky), 0),
            "fresh callback custody remains backed"
        );
        assertEq(
            source.token.allowance(address(collector), address(source.sucker)), 0, "no standing principal allowance"
        );
        assertEq(feeToken.balanceOf(feePayer), 0, "fresh fee receipt reaches the current caller");
        assertEq(source.sucker.retainedToRemoteFeeOf(feePayer), 0, "no retained caller fee remains");
        assertEq(source.sucker.retainedTransportPaymentRefundOf(feePayer), 0, "no retained transport refund remains");
    }

    /// @notice Proves deterministic identity within one home family and separation from another family.
    /// @param destinationChainId The home chain included in every source deployment's constructor arguments.
    function _assertCollectorFamilyParity(uint256 destinationChainId) internal {
        uint256[4] memory chains = [uint256(1), _OPTIMISM, _BASE, _ARBITRUM];
        address expectedCollector;
        address expectedFeePayer;
        bytes32 expectedCollectorHash;
        bytes32 expectedFeePayerHash;
        Source memory source;
        for (uint256 i = 0; i < chains.length; ++i) {
            source = _source(chains[i], 1);
            StickySourceCollector collector = _deployCollector({source: source, destinationChainId: destinationChainId});
            address feePayer = address(collector.FEE_PAYER());
            if (i == 0) {
                expectedCollector = address(collector);
                expectedFeePayer = feePayer;
                expectedCollectorHash = address(collector).codehash;
                expectedFeePayerHash = feePayer.codehash;
            }
            assertEq(address(collector), expectedCollector, "same configured reserved split hook");
            assertEq(feePayer, expectedFeePayer, "same parent-bound fee child");
            assertEq(address(collector).codehash, expectedCollectorHash, "same full hook runtime");
            assertEq(feePayer.codehash, expectedFeePayerHash, "same full fee-child runtime");
            assertEq(
                StickyRewardReceiverFactory(_ethereum.suite.rewardReceiverFactory).predictReceiverOf({
                    stickyToken: address(_sticky), groupId: 0
                }),
                _receiver,
                "same receiver prediction for the family across source chains"
            );
        }
        StickySourceCollector otherFamily =
            _deployCollector({source: source, destinationChainId: destinationChainId == 1 ? _BASE : 1});
        assertNotEq(address(otherFamily), expectedCollector, "different home chains have distinct hook addresses");
        assertNotEq(address(otherFamily.FEE_PAYER()), expectedFeePayer, "fee custody belongs to one home family");
        assertNotEq(address(otherFamily).codehash, expectedCollectorHash, "runtime binds the selected home chain");
    }

    /// @notice Uses the production deployment helper while proving all six existing singletons remain untouched.
    /// @param source The pinned source contracts supplying canonical deployment dependencies.
    /// @param destinationChainId The immutable home chain of the collector family.
    /// @return collector The locally deployed and verified shared reserved split hook.
    function _deployCollector(
        Source memory source,
        uint256 destinationChainId
    )
        internal
        returns (StickySourceCollector collector)
    {
        StickyCoreDeployment memory core = StickyCoreDeployment({
            controller: source.controller,
            directory: source.controller.DIRECTORY(),
            terminal: IJBMultiTerminal(address(source.terminal)),
            registry: block.chainid == 1 ? _checkedSucker(1, 1, _OPTIMISM).REGISTRY() : source.sucker.REGISTRY()
        });
        StickyDeploymentHarness harness = new StickyDeploymentHarness();
        StickyDeploymentAddresses memory predicted =
            harness.predict({core: core, destinationChainId: destinationChainId});
        address[6] memory existing = [
            predicted.deployer,
            predicted.hook,
            predicted.distributor,
            predicted.rewardReceiver,
            predicted.rewardReceiverFactory,
            predicted.autoStick
        ];
        bytes32[6] memory previousHashes;
        for (uint256 i = 0; i < existing.length; ++i) {
            assertGt(existing[i].code.length, 0, "the historical Sticky singleton already exists");
            previousHashes[i] = existing[i].codehash;
        }
        StickyDeploymentAddresses memory deployed =
            harness.deployFor({core: core, destinationChainId: destinationChainId});
        for (uint256 i = 0; i < existing.length; ++i) {
            assertEq(existing[i].codehash, previousHashes[i], "the deployment preserves all existing runtime code");
        }
        assertEq(abi.encode(deployed), abi.encode(predicted), "production deployment agrees with its prediction");
        assertEq(deployed.rewardReceiverFactory, _ethereum.suite.rewardReceiverFactory, "shared receiver factory");
        collector = StickySourceCollector(deployed.sourceCollector);
        assertEq(deployed.destinationChainId, destinationChainId, "manifest identifies the selected family");
        assertEq(collector.DESTINATION_CHAIN_ID(), destinationChainId, "immutable home-chain binding");
        assertEq(address(collector.FEE_PAYER()), deployed.sourceFeePayer, "verified child binding");
        assertTrue(collector.supportsInterface(type(IJBSplitHook).interfaceId), "reserved split-hook interface");
    }

    /// @notice Qualifies a generic source through actual core cashout and bridge submission for the chosen backing.
    /// @dev This source-only fixture does not launch a counterpart project or model ERC-20 withdrawal finalization.
    /// @param backingToken The local native sentinel or canonical OP USDC.e contract.
    /// @param backingAmount The actual terminal payment, in backing-token atoms; zero uses owner issuance instead.
    function _genericCollected(address backingToken, uint256 backingAmount) internal {
        Source memory canonical = _source({chainId: _OPTIMISM, projectId: 1});
        StickySourceCollector collector = _deployCollector({source: canonical, destinationChainId: 1});
        Source memory source =
            _launchGenericSource({canonical: canonical, collector: collector, backingToken: backingToken});
        uint256 reward;
        if (backingAmount == 0) {
            uint256 issuance = 100 ether;
            vm.prank(source.custodian);
            assertEq(
                source.controller
                    .mintTokensOf({
                        projectId: source.projectId,
                        tokenCount: issuance,
                        beneficiary: _payer,
                        memo: "zero-backed reward",
                        useReservedPercent: true
                    }),
                issuance / 2
            );
            reward = issuance / 2;
        } else {
            IERC20 token = IERC20(backingToken);
            // Supply only bounded test input. Payment, backing, project issuance and bridge burn use real contracts.
            deal(backingToken, _payer, backingAmount);
            vm.startPrank(_payer);
            assertTrue(token.approve({spender: address(source.terminal), value: backingAmount}));
            uint256 issued = source.terminal
                .pay({
                    projectId: source.projectId,
                    token: backingToken,
                    amount: backingAmount,
                    beneficiary: _payer,
                    minReturnedTokens: 1,
                    memo: "six-decimal backing qualification",
                    metadata: ""
                });
            vm.stopPrank();
            assertEq(token.balanceOf(_payer), 0, "the real terminal received all test backing");
            reward = source.controller.pendingReservedTokenBalanceOf(source.projectId);
            assertEq(source.token.balanceOf(_payer), issued, "actual project token issuance from the payment");
            assertGt(reward, 0);
        }
        vm.prank(_keeper);
        assertEq(source.controller.sendReservedTokensToSplitsOf(source.projectId), reward);
        assertEq(collector.pendingOf(source.projectId, address(_sticky), 0), reward, "generic reserve attribution");
        assertEq(collector.totalPendingOf(source.projectId), reward);
        assertEq(source.token.balanceOf(address(collector)), reward);
        JBOutboxTree memory beforeOutbox = source.sucker.outboxOf(backingToken);
        assertEq(beforeOutbox.tree.count, 0, "acceptance does not prepare a bridge leaf");
        uint256 supplyBefore = source.token.totalSupply();
        uint256 backingBefore = IJBMultiTerminal(address(source.terminal))
            .STORE()
            .balanceOf(address(source.terminal), source.projectId, backingToken);
        assertEq(backingBefore, backingAmount, "actual core treasury accounting");
        uint256 backingSupplyBefore = backingToken == JBConstants.NATIVE_TOKEN ? 0 : IERC20(backingToken).totalSupply();
        uint256 fee = source.sucker.REGISTRY().toRemoteFee();
        vm.deal(_keeper, fee);
        vm.recordLogs();
        vm.prank(_keeper);
        // The unrelated caller supplies registry fees only, with no approval or reward-token inventory.
        // forge-lint: disable-next-item(arbitrary-send-eth)
        uint256 index = collector.send{value: fee}({
            sourceProjectId: source.projectId,
            stickyToken: address(_sticky),
            groupId: 0,
            amount: reward,
            sucker: source.sucker,
            backingToken: backingToken
        });
        Vm.Log[] memory logs = vm.getRecordedLogs();
        JBClaim memory claimData = _collectorClaim({
            logs: logs,
            source: source,
            collector: collector,
            beforeOutbox: beforeOutbox,
            reward: reward,
            backingToken: backingToken
        });
        assertEq(index, 0, "first leaf of the new generic route");
        assertEq(claimData.leaf.index, index);
        assertEq(source.token.totalSupply(), supplyBefore - reward, "actual generic source-token burn");
        assertEq(source.token.balanceOf(address(collector)), 0);
        assertEq(collector.pendingOf(source.projectId, address(_sticky), 0), 0);
        assertEq(collector.totalPendingOf(source.projectId), 0);
        assertEq(source.token.allowance(address(collector), address(source.sucker)), 0);
        JBOutboxTree memory afterOutbox = source.sucker.outboxOf(backingToken);
        assertEq(afterOutbox.tree.count, 1);
        assertEq(afterOutbox.numberOfClaimsSent, 1, "exact generic leaf included in the dispatched root");
        assertEq(afterOutbox.balance, 0);
        bytes32 remoteToken = source.sucker.remoteTokenFor(backingToken).addr;
        OpMessage memory message = _captureOpMessageFor({
            logs: logs, source: JBOptimismSucker(payable(address(source.sucker))), value: 0, remoteToken: remoteToken
        });
        JBMessageRoot memory root = abi.decode(Bytes.slice(message.data, _SELECTOR_BYTES), (JBMessageRoot));
        assertEq(root.amount, claimData.leaf.terminalTokenAmount, "actual backing count in captured remote root");
        assertEq(
            root.remoteRoot.root,
            MerkleLib.branchRoot(
                keccak256(
                    abi.encode(reward, claimData.leaf.terminalTokenAmount, claimData.leaf.beneficiary, bytes32(0))
                ),
                claimData.proof,
                index
            ),
            "captured message includes the selected Sticky beneficiary and exact project-token count"
        );
        assertEq(
            IJBMultiTerminal(address(source.terminal))
                .STORE()
                .balanceOf(address(source.terminal), source.projectId, backingToken),
            backingBefore - claimData.leaf.terminalTokenAmount,
            "actual treasury debit equals the source bridge amount"
        );
        if (backingAmount == 0) {
            assertEq(claimData.leaf.terminalTokenAmount, 0, "zero backing still carries positive project-token count");
        } else {
            assertGt(claimData.leaf.terminalTokenAmount, 0);
            assertLt(
                claimData.leaf.terminalTokenAmount, backingAmount, "half issuance cannot consume all treasury backing"
            );
            assertEq(
                IERC20(backingToken).totalSupply(),
                backingSupplyBefore - claimData.leaf.terminalTokenAmount,
                "canonical L2 bridge burns exactly the reclaimed USDC.e atoms"
            );
            assertEq(IERC20(backingToken).balanceOf(address(source.sucker)), 0, "no source backing left in sucker");
            assertEq(
                IERC20(backingToken)
                    .allowance(
                        address(source.sucker), address(JBOptimismSucker(payable(address(source.sucker))).OPBRIDGE())
                    ),
                0,
                "no standing bridge allowance"
            );
        }
        if (backingToken != JBConstants.NATIVE_TOKEN) {
            assertEq(
                source.sucker.outboxOf(JBConstants.NATIVE_TOKEN).tree.count, 0, "ERC-20 send never uses native outbox"
            );
        }
    }

    /// @notice Launches a generic project and installs a real registered OP route with the selected backing mapping.
    /// @param canonical The deployed V6 core contracts and canonical source registry.
    /// @param collector The shared reserved split hook.
    /// @param backingToken The actual backing asset accepted by the new source project.
    /// @return source The newly configured generic source project and its canonical native transport implementation.
    function _launchGenericSource(
        Source memory canonical,
        StickySourceCollector collector,
        address backingToken
    )
        internal
        returns (Source memory source)
    {
        source.forkId = canonical.forkId;
        source.controller = canonical.controller;
        source.terminal = canonical.terminal;
        source.custodian = makeAddr("generic source project owner");
        IJBSuckerRegistry registry = canonical.sucker.REGISTRY();
        JBRulesetConfig[] memory rulesets = new JBRulesetConfig[](1);
        rulesets[0].weight = 1 ether;
        rulesets[0].metadata.reservedPercent = JBConstants.MAX_RESERVED_PERCENT / 2;
        rulesets[0].metadata.allowOwnerMinting = true;
        rulesets[0].metadata.scopeCashOutsToLocalBalances = true;
        // Juicebox's token-derived currency intentionally keeps the low four address bytes.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 currency = uint32(uint160(backingToken));
        rulesets[0].metadata.baseCurrency = currency;
        JBSplit[] memory splits = new JBSplit[](1);
        splits[0] = JBSplit({
            percent: JBConstants.SPLITS_TOTAL_PERCENT,
            projectId: 0,
            beneficiary: payable(address(_sticky)),
            preferAddToBalance: false,
            lockedUntil: 0,
            hook: IJBSplitHook(address(collector))
        });
        rulesets[0].splitGroups = new JBSplitGroup[](1);
        rulesets[0].splitGroups[0] = JBSplitGroup({groupId: _RESERVED_GROUP, splits: splits});
        JBAccountingContext[] memory contexts = new JBAccountingContext[](1);
        contexts[0] = JBAccountingContext({
            token: backingToken,
            decimals: backingToken == JBConstants.NATIVE_TOKEN ? 18 : IERC20Metadata(backingToken).decimals(),
            currency: currency
        });
        JBTerminalConfig[] memory terminals = new JBTerminalConfig[](1);
        terminals[0] = JBTerminalConfig({terminal: source.terminal, accountingContextsToAccept: contexts});
        uint256 creationFee = source.controller.PROJECTS().creationFee();
        vm.deal(address(this), address(this).balance + creationFee);
        // Only the checked canonical controller receives the fork-local project creation fee.
        // forge-lint: disable-next-item(arbitrary-send-eth)
        source.projectId = source.controller.launchProjectFor{value: creationFee}({
            owner: source.custodian,
            projectUri: "",
            rulesetConfigurations: rulesets,
            terminalConfigurations: terminals,
            memo: ""
        });
        assertGt(source.projectId, _REV_PROJECT, "generic project is outside the two initial reward sources");
        vm.prank(source.custodian);
        source.token = IERC20(
            address(
                source.controller
                    .deployERC20For({
                        projectId: source.projectId, name: "Generic source", symbol: "GEN", salt: bytes32(0)
                    })
            )
        );
        bytes32 remoteToken = bytes32(uint256(uint160(backingToken == _OP_USDCE ? _ETHEREUM_USDC : backingToken)));
        if (backingToken == _OP_USDCE && !registry.tokenMappingIsAllowed(backingToken, 1, remoteToken)) {
            // A foreign-address economic mapping requires registry-owner setup, separate from recurring delivery.
            vm.prank(Ownable(address(registry)).owner());
            registry.allowTokenMapping({localToken: backingToken, remoteChainId: 1, remoteToken: remoteToken});
        }
        string memory deployerArtifact =
            vm.readFile("node_modules/@bananapus/suckers-v6/deployments/optimism/JBOptimismSuckerDeployer.json");
        address deployer = vm.parseJsonAddress(deployerArtifact, ".address");
        assertTrue(registry.suckerDeployerIsAllowed(deployer), "existing canonical transport builder");
        JBTokenMapping[] memory mappings = new JBTokenMapping[](1);
        mappings[0] = JBTokenMapping({localToken: backingToken, minGas: 200_000, remoteToken: remoteToken});
        JBSuckerDeployerConfig[] memory configurations = new JBSuckerDeployerConfig[](1);
        configurations[0] =
            JBSuckerDeployerConfig({deployer: IJBSuckerDeployer(deployer), peer: bytes32(0), mappings: mappings});
        vm.prank(source.custodian);
        address[] memory suckers = registry.deploySuckersFor({
            projectId: source.projectId, salt: keccak256("generic source qualification"), configurations: configurations
        });
        source.sucker = JBSucker(payable(suckers[0]));
        assertTrue(registry.isSuckerOf(source.projectId, address(source.sucker)));
        assertEq(source.sucker.peerChainId(), 1);
        assertTrue(source.sucker.isMapped(backingToken));
        assertEq(source.sucker.remoteTokenFor(backingToken).addr, remoteToken);
    }

    /// @notice Exercises a native source route end-to-end, retaining its explicit current-custodian boundary.
    function _remoteReserved(uint256 chainId, uint256 projectId) internal {
        Source memory source = _source(chainId, projectId);
        JBClaim memory claimData = _prepareReserved(source);
        ArbitrumMessage memory arbMessage;
        OpMessage memory opMessage;
        if (chainId == _ARBITRUM) arbMessage = _sendArbitrum(source);
        else opMessage = _sendOp(source);
        _completeRemote(source, chainId, claimData, arbMessage, opMessage);
    }

    /// @notice Proves transport and completes the shared destination lifecycle for an actually submitted source leaf.
    function _completeRemote(
        Source memory source,
        uint256 chainId,
        JBClaim memory claimData,
        ArbitrumMessage memory arbMessage,
        OpMessage memory opMessage
    )
        internal
    {
        bytes memory data = chainId == _ARBITRUM ? arbMessage.data : opMessage.data;
        uint256 value = chainId == _ARBITRUM ? arbMessage.value : opMessage.value;
        _assertEmittedRoot(source, claimData, data, value);
        vm.selectFork(_ethereum.forkId);
        JBSucker destination = _checkedSucker(1, source.projectId, chainId);
        IERC20 rewardToken =
            IERC20(vm.parseJsonAddress(_inventory, string.concat(_projectKey(1, source.projectId), ".token")));
        assertEq(destination.peer(), bytes32(uint256(uint160(address(source.sucker)))));
        vm.expectPartialRevert(JBSucker.JBSucker_InvalidProof.selector);
        destination.claim(claimData);
        assertEq(rewardToken.balanceOf(_receiver), 0, "claim cannot front-run delivery");
        JBMessageRoot memory root = abi.decode(Bytes.slice(data, _SELECTOR_BYTES), (JBMessageRoot));
        vm.expectRevert();
        vm.prank(_keeper);
        destination.fromRemote(root);
        uint256 snapshot = vm.snapshotState();
        bool accepted;
        if (chainId == _ARBITRUM) (accepted,) = _deliverArbitrumMessage(arbMessage, _keeper);
        else accepted = _deliverOpMessage(opMessage, _keeper);
        assertFalse(accepted, "deployed destination rejects the wrong remote peer");
        assertTrue(vm.revertToState(snapshot), "restore only the negative transport attempt");
        if (chainId == _ARBITRUM) (accepted,) = _deliverArbitrumMessage(arbMessage, arbMessage.sender);
        else accepted = _deliverOpMessage(opMessage, opMessage.sender);
        assertTrue(accepted, "actual deployed bridge/messenger accepted captured call");
        assertEq(destination.inboxOf(JBConstants.NATIVE_TOKEN).root, root.remoteRoot.root);
        _claimSettle(source, destination, rewardToken, claimData);
    }

    /// @notice Claims the actual mapped ERC-20, settles to the existing distributor, then completes holder collection.
    function _claimSettle(
        Source memory source,
        JBSucker destination,
        IERC20 reward,
        JBClaim memory claimData
    )
        internal
    {
        uint256 supplyBefore = reward.totalSupply();
        uint256 destinationBefore = address(destination).balance;
        IJBMultiTerminal terminal = IJBMultiTerminal(
            address(_ethereum.core.directory.primaryTerminalOf(source.projectId, JBConstants.NATIVE_TOKEN))
        );
        uint256 backingBefore =
            terminal.STORE().balanceOf(address(terminal), source.projectId, JBConstants.NATIVE_TOKEN);
        vm.prank(_keeper);
        destination.claim(claimData);
        assertEq(reward.totalSupply(), supplyBefore + claimData.leaf.projectTokenCount, "exact counterpart mint");
        assertEq(reward.balanceOf(_receiver), claimData.leaf.projectTokenCount);
        assertEq(address(destination).balance, destinationBefore - claimData.leaf.terminalTokenAmount);
        assertEq(
            terminal.STORE().balanceOf(address(terminal), source.projectId, JBConstants.NATIVE_TOKEN),
            backingBefore + claimData.leaf.terminalTokenAmount
        );
        vm.expectPartialRevert(JBSucker.JBSucker_LeafAlreadyExecuted.selector);
        destination.claim(claimData);
        vm.prank(_keeper);
        uint256 settled =
            StickyRewardReceiverFactory(_ethereum.suite.rewardReceiverFactory).settleFor(address(_sticky), 0, reward);
        assertEq(settled, claimData.leaf.projectTokenCount);
        assertEq(reward.balanceOf(_receiver), 0);
        assertEq(reward.allowance(_receiver, address(_distributor)), 0);
        assertEq(reward.balanceOf(_keeper), 0, "keeper receives no rewards");
        assertEq(
            StickyRewardReceiverFactory(_ethereum.suite.rewardReceiverFactory).settleFor(address(_sticky), 0, reward), 0
        );
        _vestCollectAndRedeem(reward, settled);
    }

    /// @notice Appends a real reserved-token leaf using the current Safe custodian's actual token inventory.
    function _prepareReserved(Source memory source) internal returns (JBClaim memory claimData) {
        _flushReserved(source);
        uint256 reward = _issueReserved(source);
        uint256 beforeReserved = source.token.balanceOf(source.custodian);
        vm.prank(_keeper);
        assertEq(source.controller.sendReservedTokensToSplitsOf(source.projectId), reward);
        assertEq(source.token.balanceOf(source.custodian), beforeReserved + reward, "real current reserved split paid");
        JBOutboxTree memory beforeOutbox = source.sucker.outboxOf(JBConstants.NATIVE_TOKEN);
        claimData = _claimAgainstFrontier(
            JBLeaf({
                index: beforeOutbox.tree.count,
                beneficiary: bytes32(uint256(uint160(_receiver))),
                projectTokenCount: reward,
                terminalTokenAmount: 0,
                metadata: keccak256("Sticky JBX reserved rewards")
            }),
            beforeOutbox
        );
        uint256 supplyBefore = source.token.totalSupply();
        uint256 backingBefore = _backing(source);
        uint256 escrowBefore = address(source.sucker).balance;
        vm.startPrank(source.custodian);
        assertTrue(source.token.approve(address(source.sucker), reward));
        source.sucker.prepare(reward, claimData.leaf.beneficiary, 1, JBConstants.NATIVE_TOKEN, claimData.leaf.metadata);
        vm.stopPrank();
        JBOutboxTree memory afterOutbox = source.sucker.outboxOf(JBConstants.NATIVE_TOKEN);
        claimData.leaf.terminalTokenAmount = afterOutbox.balance - beforeOutbox.balance;
        assertGt(claimData.leaf.terminalTokenAmount, 0, "real backing reclaimed");
        assertEq(source.token.balanceOf(source.custodian), beforeReserved);
        assertEq(source.token.totalSupply(), supplyBefore - reward, "source reserved tokens actually burned");
        assertEq(_backing(source), backingBefore - claimData.leaf.terminalTokenAmount);
        assertEq(address(source.sucker).balance, escrowBefore + claimData.leaf.terminalTokenAmount);
        assertEq(afterOutbox.tree.count, beforeOutbox.tree.count + 1);
    }

    /// @notice Proves one appended leaf from the deployed tree's existing left-sibling frontier.
    function _claimAgainstFrontier(
        JBLeaf memory leaf,
        JBOutboxTree memory beforeOutbox
    )
        internal
        pure
        returns (JBClaim memory claimData)
    {
        claimData.token = JBConstants.NATIVE_TOKEN;
        claimData.leaf = leaf;
        bytes32 zero = bytes32(0);
        for (uint256 i = 0; i < _MERKLE_DEPTH; ++i) {
            claimData.proof[i] = (beforeOutbox.tree.count >> i) & 1 == 1 ? beforeOutbox.tree.branch[i] : zero;
            zero = keccak256(abi.encode(zero, zero));
        }
    }

    /// @notice Pays the real terminal, preserving the recipient and pending-reserve deltas of the deployed ruleset.
    function _issueReserved(Source memory source) internal returns (uint256 reward) {
        uint256 pendingBefore = source.controller.pendingReservedTokenBalanceOf(source.projectId);
        uint256 payerBefore = source.token.balanceOf(_payer);
        vm.deal(_payer, _NATIVE_INPUT);
        vm.prank(_payer);
        // Only the primary terminal resolved from the deployed directory receives this test payment.
        // forge-lint: disable-next-item(arbitrary-send-eth)
        uint256 issued = source.terminal.pay{value: _NATIVE_INPUT}(
            source.projectId, JBConstants.NATIVE_TOKEN, _NATIVE_INPUT, _payer, 1, "reserved qualification", ""
        );
        assertEq(source.token.balanceOf(_payer), payerBefore + issued, "actual payment token issuance");
        reward = source.controller.pendingReservedTokenBalanceOf(source.projectId) - pendingBefore;
        assertGt(reward, 0, "actual payment generates reserved entitlement");
    }

    /// @notice Separates historical pending reserves from the new payment without minting or replacing balances.
    function _flushReserved(Source memory source) internal {
        if (source.controller.pendingReservedTokenBalanceOf(source.projectId) != 0) {
            vm.prank(_keeper);
            source.controller.sendReservedTokensToSplitsOf(source.projectId);
        }
        assertEq(source.controller.pendingReservedTokenBalanceOf(source.projectId), 0);
    }

    /// @notice Captures the deployed OP messenger's exact native withdrawal submission.
    function _sendOp(Source memory source) internal returns (OpMessage memory message) {
        uint256 value = source.sucker.outboxOf(JBConstants.NATIVE_TOKEN).balance;
        vm.recordLogs();
        _send(source.sucker);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        message = _captureOpMessage(logs, JBOptimismSucker(payable(address(source.sucker))), value);
    }

    /// @notice Captures the real Arbitrum sucker call at the ArbSys consensus boundary.
    function _sendArbitrum(Source memory source) internal returns (ArbitrumMessage memory message) {
        _startArbitrumMessageCapture();
        _send(source.sucker);
        message = _finishArbitrumMessageCapture(JBArbitrumSucker(payable(address(source.sucker))));
    }

    /// @notice An unrelated keeper can send already-prepared reserves using only the live registry fee.
    function _send(JBSucker sucker) internal {
        uint256 fee = sucker.REGISTRY().toRemoteFee();
        vm.deal(_keeper, fee);
        vm.prank(_keeper);
        // This is a runtime-checked deployed registry sucker.
        // forge-lint: disable-next-line(arbitrary-send-eth)
        sucker.toRemote{value: fee}(JBConstants.NATIVE_TOKEN);
    }

    /// @notice Binds transport to the source's actual Merkle frontier, values and committed reserved leaf.
    function _assertEmittedRoot(
        Source memory source,
        JBClaim memory claimData,
        bytes memory data,
        uint256 value
    )
        internal
        view
    {
        // Intentionally inspect the leading ABI selector of the captured full calldata.
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(bytes4(data), JBSucker.fromRemote.selector);
        JBMessageRoot memory root = abi.decode(Bytes.slice(data, _SELECTOR_BYTES), (JBMessageRoot));
        assertEq(root.amount, value);
        assertGe(value, claimData.leaf.terminalTokenAmount);
        assertEq(
            root.remoteRoot.root,
            MerkleLib.branchRoot(
                keccak256(
                    abi.encode(
                        claimData.leaf.projectTokenCount,
                        claimData.leaf.terminalTokenAmount,
                        claimData.leaf.beneficiary,
                        claimData.leaf.metadata
                    )
                ),
                claimData.proof,
                claimData.leaf.index
            )
        );
        JBOutboxTree memory outbox = source.sucker.outboxOf(JBConstants.NATIVE_TOKEN);
        assertEq(outbox.balance, 0);
        assertEq(outbox.numberOfClaimsSent, outbox.tree.count);
    }

    /// @notice Completes actual production vesting and permissionless collection to the sole JBX holder.
    function _vestCollectAndRedeem(IERC20 reward, uint256 amount) internal {
        IERC20[] memory rewards = new IERC20[](1);
        rewards[0] = reward;
        uint256[] memory ids = new uint256[](1);
        ids[0] = uint256(uint160(_holder));
        assertEq(_distributor.balanceOf(address(_sticky), reward), amount);
        vm.warp(_distributor.roundStartTimestamp(_distributor.currentRound() + 1));
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(_keeper);
        _distributor.beginVesting(address(_sticky), 0, ids, rewards);
        assertEq(_distributor.collectableFor(address(_sticky), 0, ids[0], reward), 0, "initial vesting locked");
        vm.warp(_distributor.roundStartTimestamp(_distributor.currentRound() + _distributor.VESTING_ROUNDS() + 1));
        vm.roll(vm.getBlockNumber() + 1);
        assertEq(_distributor.collectableFor(address(_sticky), 0, ids[0], reward), amount);
        vm.expectRevert();
        vm.prank(_keeper);
        _distributor.collectVestedRewards(address(_sticky), 0, ids, rewards, _keeper);
        uint256 beforeBalance = reward.balanceOf(_holder);
        vm.prank(_keeper);
        _distributor.collectVestedRewards(address(_sticky), 0, ids, rewards, _holder);
        assertEq(reward.balanceOf(_holder), beforeBalance + amount, "reserved reward reaches JBX staker wallet");
        assertEq(_distributor.balanceOf(address(_sticky), reward), 0);
        vm.prank(_keeper);
        _distributor.collectVestedRewards(address(_sticky), 0, ids, rewards, _holder);
        assertEq(reward.balanceOf(_holder), beforeBalance + amount, "no duplicate reward collection");
        assertEq(_cashOut(_ethereum, _stickyProjectId, _holder, _sticky.balanceOf(_holder), _STAKE), _STAKE);
        assertEq(_ethereum.underlying.balanceOf(_holder), _STAKE, "all actual JBX backing remains redeemable");
    }

    /// @notice Selects pinned real contracts and checks actual identity before mutating the local fork.
    function _source(uint256 chainId, uint256 projectId) internal returns (Source memory source) {
        string memory chainKey = string.concat(".chains.", vm.toString(chainId));
        if (chainId == 1) {
            vm.selectFork(_ethereum.forkId);
            source.forkId = _ethereum.forkId;
        } else {
            source.forkId = _selectPinnedFork(
                vm.parseJsonString(_inventory, string.concat(chainKey, ".rpcAlias")),
                vm.parseJsonUint(_inventory, string.concat(chainKey, ".blockNumber")),
                chainId,
                vm.parseJsonBytes32(_inventory, string.concat(chainKey, ".blockHash"))
            );
        }
        if (chainId == _ARBITRUM) {
            assertEq(
                block.number,
                vm.parseJsonUint(_inventory, string.concat(chainKey, ".evmBlockNumber")),
                "recorded Arbitrum EVM height agrees with the pinned header"
            );
        }
        uint256 contractCount = vm.parseJsonUint(_inventory, string.concat(chainKey, ".contractCount"));
        for (uint256 i = 0; i < contractCount; ++i) {
            // Bounded census reads use cheatcodes, not untrusted contract callbacks.
            // forge-lint: disable-next-line(calls-loop)
            string memory key = string.concat(chainKey, ".contracts[", vm.toString(i), "]");
            // forge-lint: disable-next-line(calls-loop)
            address target = vm.parseJsonAddress(_inventory, string.concat(key, ".address"));
            assertEq(
                target.codehash,
                // forge-lint: disable-next-line(calls-loop)
                vm.parseJsonBytes32(_inventory, string.concat(key, ".codeHash")),
                "pinned source runtime"
            );
        }
        string memory projectKey = _projectKey(chainId, projectId);
        source.projectId = projectId;
        source.controller = IJBController(vm.parseJsonAddress(_inventory, string.concat(projectKey, ".controller")));
        source.token = IERC20(vm.parseJsonAddress(_inventory, string.concat(projectKey, ".token")));
        source.custodian = vm.parseJsonAddress(_inventory, string.concat(projectKey, ".reservedSplits[0].beneficiary"));
        assertEq(
            address(source.token).codehash, vm.parseJsonBytes32(_inventory, string.concat(projectKey, ".tokenCodeHash"))
        );
        assertEq(address(source.controller.TOKENS().tokenOf(projectId)), address(source.token));
        (JBRuleset memory ruleset, JBRulesetMetadata memory metadata) = source.controller.currentRulesetOf(projectId);
        source.rulesetId = ruleset.id;
        assertEq(metadata.reservedPercent, vm.parseJsonUint(_inventory, string.concat(projectKey, ".reservedPercent")));
        JBSplit[] memory currentSplits = source.controller.SPLITS().splitsOf(projectId, ruleset.id, _RESERVED_GROUP);
        assertEq(currentSplits.length, 1);
        assertEq(currentSplits[0].beneficiary, source.custodian, "actual current reserve custodian");
        assertEq(currentSplits[0].percent, JBConstants.SPLITS_TOTAL_PERCENT);
        assertEq(address(currentSplits[0].hook), address(0), "current source has no automatic split hook");
        assertEq(currentSplits[0].projectId, 0);
        source.terminal = source.controller.DIRECTORY().primaryTerminalOf(projectId, JBConstants.NATIVE_TOKEN);
        assertGt(address(source.terminal).code.length, 0);
        if (chainId != 1) source.sucker = _checkedSucker(chainId, projectId, 1);
    }

    /// @notice Checks a reciprocal deployed native mapping, runtime and implementation against the recorded census.
    function _checkedSucker(
        uint256 chainId,
        uint256 projectId,
        uint256 peerChain
    )
        internal
        view
        returns (JBSucker sucker)
    {
        string memory key = string.concat(_projectKey(chainId, projectId), ".nativeRoutes.", vm.toString(peerChain));
        sucker = JBSucker(payable(vm.parseJsonAddress(_inventory, string.concat(key, ".sucker"))));
        assertEq(address(sucker).codehash, vm.parseJsonBytes32(_inventory, string.concat(key, ".codeHash")));
        address implementation = vm.parseJsonAddress(_inventory, string.concat(key, ".implementation"));
        assertEq(
            implementation.codehash, vm.parseJsonBytes32(_inventory, string.concat(key, ".implementationCodeHash"))
        );
        assertEq(sucker.projectId(), projectId);
        assertEq(sucker.peerChainId(), peerChain);
        assertEq(sucker.peer(), bytes32(uint256(uint160(vm.parseJsonAddress(_inventory, string.concat(key, ".peer"))))));
        assertTrue(sucker.REGISTRY().isSuckerOf(projectId, address(sucker)));
        assertTrue(sucker.isMapped(JBConstants.NATIVE_TOKEN), "supported native mapping");
    }

    /// @notice Reads real local terminal backing, without substituting a backing token or synthetic balance.
    function _backing(Source memory source) internal view returns (uint256) {
        return IJBMultiTerminal(address(source.terminal))
            .STORE()
            .balanceOf(address(source.terminal), source.projectId, JBConstants.NATIVE_TOKEN);
    }

    /// @notice Resolves the route's actual fee-project ERC-20 independently from the reward project token.
    /// @param source The registered source route whose fee project supplies the receipt token.
    /// @return feeToken The deployed fee-project ERC-20 for this route.
    function _feeToken(Source memory source) internal view returns (IERC20 feeToken) {
        return IERC20(address(source.sucker.TOKENS().tokenOf(source.sucker.FEE_PROJECT_ID())));
    }

    /// @notice Addresses the one committed census entry for a project on a specific chain.
    function _projectKey(uint256 chainId, uint256 projectId) internal pure returns (string memory) {
        return string.concat(".chains.", vm.toString(chainId), ".projects.", vm.toString(projectId));
    }
}

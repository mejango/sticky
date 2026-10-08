// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IJBController} from "@bananapus/core-v6/src/interfaces/IJBController.sol";
import {IJBMultiTerminal} from "@bananapus/core-v6/src/interfaces/IJBMultiTerminal.sol";
import {IJBTerminal} from "@bananapus/core-v6/src/interfaces/IJBTerminal.sol";
import {IJBSplitHook} from "@bananapus/core-v6/src/interfaces/IJBSplitHook.sol";
import {JBConstants} from "@bananapus/core-v6/src/libraries/JBConstants.sol";
import {JBRuleset} from "@bananapus/core-v6/src/structs/JBRuleset.sol";
import {JBRulesetMetadata} from "@bananapus/core-v6/src/structs/JBRulesetMetadata.sol";
import {JBSplit} from "@bananapus/core-v6/src/structs/JBSplit.sol";
import {JBSplitGroup} from "@bananapus/core-v6/src/structs/JBSplitGroup.sol";
import {JBArbitrumSucker} from "@bananapus/suckers-v6/src/JBArbitrumSucker.sol";
import {JBOptimismSucker} from "@bananapus/suckers-v6/src/JBOptimismSucker.sol";
import {JBSucker} from "@bananapus/suckers-v6/src/JBSucker.sol";
import {JBClaim} from "@bananapus/suckers-v6/src/structs/JBClaim.sol";
import {JBLeaf} from "@bananapus/suckers-v6/src/structs/JBLeaf.sol";
import {JBMessageRoot} from "@bananapus/suckers-v6/src/structs/JBMessageRoot.sol";
import {JBOutboxTree} from "@bananapus/suckers-v6/src/structs/JBOutboxTree.sol";
import {MerkleLib} from "@bananapus/suckers-v6/src/utils/MerkleLib.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Bytes} from "@openzeppelin/contracts/utils/Bytes.sol";
import {Vm} from "forge-std/Vm.sol";

import {StickyDistributor} from "../../src/StickyDistributor.sol";
import {StickyRewardReceiverFactory} from "../../src/StickyRewardReceiverFactory.sol";
import {StickySourceCollector} from "../../src/StickySourceCollector.sol";
import {StickyToken} from "../../src/StickyToken.sol";
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
/// reviewed local implementation on each pinned fork and require no privileged caller after split configuration.
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
    bytes32 internal constant _INSERTED_LEAF =
        keccak256("InsertToOutboxTree(bytes32,address,bytes32,uint256,bytes32,uint256,uint256,bytes32,address)");
    bytes32 internal constant _COLLECTOR_SEND = keccak256("Send(uint256,uint256,uint256,uint256,uint256,address)");
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

    /// @notice Actual Ethereum project 1 reserved issuance can fund the distributor through its supported split hook.
    function test_ethereumProjectOne_reservedSplitHookToJbxHolder() public {
        _localReserved(1);
    }

    /// @notice Actual Ethereum project 3 reserved issuance can fund the distributor through its supported split hook.
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
    function test_optimismProjectOne_permissionlessCollectorToEthereumJbx() public {
        _remoteCollected(_OPTIMISM, 1);
    }

    /// @notice An unrelated caller sends OP REV's approved reward fraction while preserving the Safe remainder.
    function test_optimismProjectThree_permissionlessCollectorToEthereumJbx() public {
        _remoteCollected(_OPTIMISM, _REV_PROJECT);
    }

    /// @notice An unrelated caller distributes and sends Base JBP6 reserves after a fork-only full-reserve setup.
    function test_baseProjectOne_permissionlessCollectorToEthereumJbx() public {
        _remoteCollected(_BASE, 1);
    }

    /// @notice An unrelated caller sends Base REV's approved reward fraction while preserving the Safe remainder.
    function test_baseProjectThree_permissionlessCollectorToEthereumJbx() public {
        _remoteCollected(_BASE, _REV_PROJECT);
    }

    /// @notice An unrelated caller distributes and sends Arbitrum JBP6 reserves after a fork-only full-reserve setup.
    function test_arbitrumProjectOne_permissionlessCollectorToEthereumJbx() public {
        _remoteCollected(_ARBITRUM, 1);
    }

    /// @notice An unrelated caller sends Arbitrum REV's approved reward fraction while preserving the Safe remainder.
    function test_arbitrumProjectThree_permissionlessCollectorToEthereumJbx() public {
        _remoteCollected(_ARBITRUM, _REV_PROJECT);
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

    /// @notice Uses a supported local split hook after an actual authorized current-ruleset edit.
    function _localReserved(uint256 projectId) internal {
        Source memory source = _source(1, projectId);
        _flushReserved(source);
        JBSplit[] memory splits = new JBSplit[](1);
        splits[0] = JBSplit({
            percent: uint32(JBConstants.SPLITS_TOTAL_PERCENT),
            projectId: 0,
            beneficiary: payable(address(_sticky)),
            preferAddToBalance: false,
            lockedUntil: 0,
            hook: IJBSplitHook(address(_distributor))
        });
        JBSplitGroup[] memory groups = new JBSplitGroup[](1);
        groups[0] = JBSplitGroup({groupId: _RESERVED_GROUP, splits: splits});
        vm.prank(source.custodian);
        source.controller.setSplitGroupsOf(projectId, source.rulesetId, groups);
        uint256 reward = _issueReserved(source);
        uint256 supplyBefore = source.token.totalSupply();
        uint256 distributorBefore = source.token.balanceOf(address(_distributor));
        vm.prank(_keeper);
        assertEq(source.controller.sendReservedTokensToSplitsOf(projectId), reward);
        assertEq(source.token.totalSupply(), supplyBefore + reward, "reserved issuance actually minted");
        assertEq(
            source.token.balanceOf(address(_distributor)), distributorBefore + reward, "actual hook pulled reserves"
        );
        assertEq(source.controller.pendingReservedTokenBalanceOf(projectId), 0);
        _vestCollectAndRedeem(source.token, reward);
    }

    /// @notice Configures only the initial fork split, then uses unrelated callers throughout recurring delivery.
    function _remoteCollected(uint256 chainId, uint256 projectId) internal {
        Source memory source = _source(chainId, projectId);
        _flushReserved(source);
        StickySourceCollector collector = new StickySourceCollector({sucker: source.sucker, receiver: _receiver});
        uint256 reward = _fundCollector(source, collector);
        JBOutboxTree memory beforeOutbox = source.sucker.outboxOf(JBConstants.NATIVE_TOKEN);
        uint256 supplyBefore = source.token.totalSupply();
        uint256 nativeBefore = address(source.sucker).balance;
        uint256 callerFeeTokensBefore = collector.FEE_PAYER().FEE_TOKEN().balanceOf(_keeper);
        uint256 fee = source.sucker.REGISTRY().toRemoteFee();
        vm.deal(_keeper, fee + 1);
        vm.expectRevert(
            abi.encodeWithSelector(StickySourceCollector.StickySourceCollector_IncorrectFee.selector, fee + 1, fee)
        );
        vm.prank(_keeper);
        // Only the newly constructed fixed-route collector receives the deliberately incorrect fee.
        // forge-lint: disable-next-line(arbitrary-send-eth)
        collector.send{value: fee + 1}();
        assertEq(source.token.balanceOf(address(collector)), reward, "bad fee preserves all reserved principal");
        assertEq(abi.encode(source.sucker.outboxOf(JBConstants.NATIVE_TOKEN)), abi.encode(beforeOutbox));
        vm.deal(_keeper, fee);
        vm.recordLogs();
        if (chainId == _ARBITRUM) _startArbitrumMessageCapture();
        vm.prank(_keeper);
        // The unrelated keeper supplies only the exact live registry fee, never source tokens or an approval.
        // forge-lint: disable-next-line(arbitrary-send-eth)
        uint256 index = collector.send{value: fee}();
        ArbitrumMessage memory arbMessage;
        if (chainId == _ARBITRUM) {
            arbMessage = _finishArbitrumMessageCapture(JBArbitrumSucker(payable(address(source.sucker))));
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        JBClaim memory claimData = _collectorClaim(logs, source, collector, beforeOutbox, reward);
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
    function _fundCollector(Source memory source, StickySourceCollector collector) internal returns (uint256 reward) {
        uint256 percent =
            source.projectId == _REV_PROJECT ? _REV_RESERVED_REWARD_PERCENT : JBConstants.SPLITS_TOTAL_PERCENT;
        JBSplit[] memory splits = new JBSplit[](percent == JBConstants.SPLITS_TOTAL_PERCENT ? 1 : 2);
        // Both split percentages are bounded by the protocol's 1e9 denominator, below uint32 max.
        // forge-lint: disable-next-item(unsafe-typecast)
        splits[0] = JBSplit({
            percent: uint32(percent),
            projectId: 0,
            beneficiary: payable(address(collector)),
            preferAddToBalance: false,
            lockedUntil: 0,
            hook: IJBSplitHook(address(0))
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
    function _collectorClaim(
        Vm.Log[] memory logs,
        Source memory source,
        StickySourceCollector collector,
        JBOutboxTree memory beforeOutbox,
        uint256 reward
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
            assertEq(entry.topics[2], bytes32(uint256(uint160(JBConstants.NATIVE_TOKEN))));
            InsertedLeaf memory inserted = abi.decode(entry.data, (InsertedLeaf));
            assertEq(inserted.caller, address(collector), "collector itself prepared the source leaf");
            assertEq(inserted.index, beforeOutbox.tree.count);
            assertEq(inserted.projectTokenCount, reward);
            assertGt(inserted.terminalTokenAmount, 0);
            assertEq(inserted.metadata, bytes32(0), "fixed collector leaf attribution");
            JBLeaf memory leaf = JBLeaf({
                index: inserted.index,
                beneficiary: entry.topics[1],
                projectTokenCount: reward,
                terminalTokenAmount: inserted.terminalTokenAmount,
                metadata: inserted.metadata
            });
            claimData = _claimAgainstFrontier(leaf, beforeOutbox);
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
        uint256 sendEvents = 0;
        for (uint256 i = 0; i < logs.length; ++i) {
            Vm.Log memory entry = logs[i];
            if (entry.emitter == address(collector) && entry.topics.length != 0 && entry.topics[0] == _COLLECTOR_SEND) {
                assertEq(entry.topics.length, 3);
                assertEq(entry.topics[2], bytes32(uint256(uint160(_keeper))), "send identifies the unrelated fee payer");
                (uint256 projectTokenCount,, uint256 paidFeeTokens,) =
                    abi.decode(entry.data, (uint256, uint256, uint256, uint256));
                assertEq(projectTokenCount, reward);
                feeReceipt = paidFeeTokens;
                ++sendEvents;
            }

            if (
                entry.emitter != address(source.token) || entry.topics.length != 3 || entry.topics[0] != _TOKEN_TRANSFER
            ) continue;
            uint256 amount = abi.decode(entry.data, (uint256));
            if (entry.topics[1] == bytes32(0)) minted += amount;
            if (entry.topics[2] == bytes32(0)) burned += amount;
        }
        assertEq(sendEvents, 1, "one actual collector submission result");
        assertEq(
            collector.FEE_PAYER().FEE_TOKEN().balanceOf(_keeper),
            callerFeeTokensBefore + feeReceipt,
            "exact fee receipt reaches the current source caller"
        );
        assertEq(burned, reward, "exact reserved principal burned by the actual token");
        assertEq(source.token.totalSupply(), supplyBefore + minted - burned, "fee minting cannot mask principal burn");
        assertEq(source.token.balanceOf(address(collector)), 0, "fee receipts do not return to principal custody");
        assertEq(
            source.token.allowance(address(collector), address(source.sucker)), 0, "no standing principal allowance"
        );
        address feePayer = address(collector.FEE_PAYER());
        assertEq(
            collector.FEE_PAYER().FEE_TOKEN().balanceOf(feePayer), 0, "fresh fee receipt reaches the current caller"
        );
        assertEq(source.sucker.retainedToRemoteFeeOf(feePayer), 0, "no retained caller fee remains");
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

    /// @notice Addresses the one committed census entry for a project on a specific chain.
    function _projectKey(uint256 chainId, uint256 projectId) internal pure returns (string memory) {
        return string.concat(".chains.", vm.toString(chainId), ".projects.", vm.toString(projectId));
    }
}

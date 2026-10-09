// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {JBMultiTerminal} from "@bananapus/core-v6/src/JBMultiTerminal.sol";
import {IJBSplitHook} from "@bananapus/core-v6/src/interfaces/IJBSplitHook.sol";
import {JBConstants} from "@bananapus/core-v6/src/libraries/JBConstants.sol";
import {JBSplitGroupIds} from "@bananapus/core-v6/src/libraries/JBSplitGroupIds.sol";
import {JBRuleset} from "@bananapus/core-v6/src/structs/JBRuleset.sol";
import {JBSplit} from "@bananapus/core-v6/src/structs/JBSplit.sol";
import {JBSplitGroup} from "@bananapus/core-v6/src/structs/JBSplitGroup.sol";
import {JBOptimismSucker} from "@bananapus/suckers-v6/src/JBOptimismSucker.sol";
import {JBSucker} from "@bananapus/suckers-v6/src/JBSucker.sol";
import {IJBSuckerRegistry} from "@bananapus/suckers-v6/src/interfaces/IJBSuckerRegistry.sol";
import {IOPMessenger} from "@bananapus/suckers-v6/src/interfaces/IOPMessenger.sol";
import {JBClaim} from "@bananapus/suckers-v6/src/structs/JBClaim.sol";
import {JBLeaf} from "@bananapus/suckers-v6/src/structs/JBLeaf.sol";
import {JBMessageRoot} from "@bananapus/suckers-v6/src/structs/JBMessageRoot.sol";
import {JBOutboxTree} from "@bananapus/suckers-v6/src/structs/JBOutboxTree.sol";
import {MerkleLib} from "@bananapus/suckers-v6/src/utils/MerkleLib.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";

import {StickyAutoStick} from "../../src/StickyAutoStick.sol";
import {StickyDistributor} from "../../src/StickyDistributor.sol";
import {StickyHook} from "../../src/StickyHook.sol";
import {StickyRewardReceiverFactory} from "../../src/StickyRewardReceiverFactory.sol";
import {StickySourceCollector} from "../../src/StickySourceCollector.sol";
import {StickyToken} from "../../src/StickyToken.sol";

import {StickyDeploymentAddresses} from "../../script/structs/StickyDeploymentAddresses.sol";

import {StickyDeploymentHarness} from "../deployment/StickyDeploymentHarness.sol";
import {StickyRealProjectContext, StickyRealProjectFork} from "./helpers/StickyRealProjectFork.sol";

/// @notice The canonical OP messenger entry point used after a portal deposits an L1 message on Base.
// forge-lint: disable-next-line(multi-contract-file)
interface IStickyOPMessenger {
    /// @notice Whether the messenger has successfully relayed a message.
    /// @param messageHash The hash of the complete versioned relay calldata.
    /// @return success Whether the target accepted the message.
    function successfulMessages(bytes32 messageHash) external view returns (bool success);

    /// @notice Relays one cross-domain message after its portal deposit.
    /// @param nonce The source messenger's versioned message nonce.
    /// @param sender The original sender on the source chain.
    /// @param target The receiving contract on this chain.
    /// @param value The native-token amount accompanying the message.
    /// @param minimumGas The minimum gas guaranteed to the receiving call.
    /// @param message The exact calldata emitted by the source messenger.
    function relayMessage(
        uint256 nonce,
        address sender,
        address target,
        uint256 value,
        uint256 minimumGas,
        bytes calldata message
    )
        external
        payable;
}

/// @notice Bridges Ethereum project 3's real tokens into its Base counterpart's Sticky rewards.
/// @dev Only the portal deposit is simulated: the exact message emitted by the live L1 messenger is passed to the
/// live L2 messenger by its canonical aliased L1 sender, with the corresponding ETH. Both messengers, both suckers,
/// project tokens, project accounting, claims, and the production Sticky suite execute their real code. This does
/// not test the portal's consensus proof, sequencer, finality delay, or an off-chain relayer.
// forge-lint: disable-next-line(multi-contract-file)
contract StickyCrossChainRewardsForkTest is StickyRealProjectFork {
    //*********************************************************************//
    // ----------------------------- structs ----------------------------- //
    //*********************************************************************//

    /// @notice A complete native-token message emitted by the deployed L1 messenger.
    /// @custom:member sender The Ethereum sucker that submitted the message.
    /// @custom:member target The Base sucker receiving the message.
    /// @custom:member message The exact remote-call calldata.
    /// @custom:member nonce The messenger's versioned nonce.
    /// @custom:member minimumGas The destination call's gas requirement.
    /// @custom:member value The source outbox's bridged native-token balance.
    struct BridgeMessage {
        address sender;
        address target;
        bytes message;
        uint256 nonce;
        uint256 minimumGas;
        uint256 value;
    }

    //*********************************************************************//
    // ----------------------- internal constants ------------------------ //
    //*********************************************************************//

    /// @notice The OP alias applied to an L1 contract that sends a portal deposit.
    uint160 internal constant _ALIAS_OFFSET = uint160(0x1111000000000000000000000000000000001111);

    /// @notice The home chain of the Sticky pool qualified by the destination-specific collector cases.
    uint256 internal constant _BASE_CHAIN_ID = 8453;

    /// @notice The event carrying the source sucker's actual appended leaf and root.
    bytes32 internal constant _INSERTED_LEAF =
        keccak256("InsertToOutboxTree(bytes32,address,bytes32,uint256,bytes32,uint256,uint256,bytes32,address)");

    /// @notice Base's cross-domain messenger on Ethereum.
    address internal constant _L1_MESSENGER = 0x866E82a600A1414e583f7F13623F1aC5d58b0Afa;

    /// @notice The canonical OP cross-domain messenger predeploy on Base.
    address internal constant _L2_MESSENGER = 0x4200000000000000000000000000000000000007;

    /// @notice The messenger event that records the original sender, recipient, and calldata.
    bytes32 internal constant _SENT_MESSAGE = keccak256("SentMessage(address,address,bytes,uint256,uint256)");

    /// @notice The production registry shared by Ethereum and Base.
    IJBSuckerRegistry internal constant _SUCKER_REGISTRY =
        IJBSuckerRegistry(0x7903a854aE91eAf635430D120a1a434085cEf297);

    //*********************************************************************//
    // -------------------- internal stored properties ------------------- //
    //*********************************************************************//

    /// @notice The pinned Base fork and its contracts.
    StickyRealProjectContext internal _base;

    /// @notice The Base sucker that receives the bridged root.
    JBOptimismSucker internal _destination;

    /// @notice The pinned Ethereum fork and its contracts.
    StickyRealProjectContext internal _ethereum;

    /// @notice The account that pays Ethereum project 3 and bridges its tokens.
    // forge-lint: disable-next-line(function-init-state)
    address internal _funder = makeAddr("cross-chain reward funder");

    /// @notice The Sticky holder on Base who receives the bridged rewards.
    // forge-lint: disable-next-line(function-init-state)
    address internal _holder = makeAddr("cross-chain reward holder");

    /// @notice The unrelated account that claims, settles, vests, and compounds.
    // forge-lint: disable-next-line(function-init-state)
    address internal _keeper = makeAddr("cross-chain reward keeper");

    /// @notice The counterfactual reward receiver for the Sticky token's default group.
    address internal _receiver;

    /// @notice The Ethereum sucker that submits the bridged root.
    JBOptimismSucker internal _source;

    /// @notice The Sticky share token launched on Base.
    StickyToken internal _sticky;

    /// @notice The Sticky project launched on Base.
    uint256 internal _stickyProjectId;

    //*********************************************************************//
    // ----------------------- public transactions ----------------------- //
    //*********************************************************************//

    /// @notice Resolves the production native bridge route and creates a backed Sticky position on its Base peer.
    function setUp() public {
        _ethereum =
        // forge-lint: disable-next-line(literal-instead-of-constant)
        _createProjectFork({rpcAlias: "ethereum", forkBlock: _ETHEREUM_BLOCK, chainId: 1, underlyingProjectId: 3});
        // forge-lint: disable-next-line(literal-instead-of-constant)
        address[] memory suckers = _SUCKER_REGISTRY.suckersOf(3);
        // forge-lint: disable-next-line(uninitialized-local)
        for (uint256 i; i < suckers.length; i++) {
            // forge-lint: disable-next-line(calls-loop,literal-instead-of-constant)
            if (JBSucker(payable(suckers[i])).peerChainId() != 8453) continue;
            // forge-lint: disable-next-line(calls-loop)
            try JBOptimismSucker(payable(suckers[i])).OPMESSENGER() returns (IOPMessenger messenger) {
                if (address(messenger) == _L1_MESSENGER) _source = JBOptimismSucker(payable(suckers[i]));
            } catch {}
        }
        assertNotEq(address(_source), address(0), "Ethereum project 3 must have a native Base sucker");
        address peer = address(uint160(uint256(_source.peer())));

        // Resolve the existing destination project from the deployed sucker before launching Sticky around it.
        // forge-lint: disable-next-line(unused-return)
        vm.createSelectFork({urlOrAlias: "base", blockNumber: _BASE_BLOCK});
        _destination = JBOptimismSucker(payable(peer));
        uint256 baseProjectId = _destination.projectId();
        assertEq(_destination.peer(), bytes32(uint256(uint160(address(_source)))));
        assertEq(_destination.peerChainId(), 1);
        assertEq(address(_destination.OPMESSENGER()), _L2_MESSENGER);
        _base = _createProjectFork({
            // forge-lint: disable-next-line(literal-instead-of-constant)
            rpcAlias: "base",
            forkBlock: _BASE_BLOCK,
            // forge-lint: disable-next-line(literal-instead-of-constant)
            chainId: 8453,
            underlyingProjectId: baseProjectId
        });
        assertTrue(_SUCKER_REGISTRY.isSuckerOf({projectId: baseProjectId, addr: address(_destination)}));
        assertTrue(_destination.isMapped(JBConstants.NATIVE_TOKEN));
        (_stickyProjectId, _sticky) = _launchSticky({context: _base, soulbound: true, cashOutTaxRate: 0});
        // forge-lint: disable-next-line(literal-instead-of-constant)
        uint256 acquired = _buyUnderlying({context: _base, holder: _holder, nativeAmount: 0.01 ether});
        _stake({context: _base, projectId: _stickyProjectId, payer: _holder, beneficiary: _holder, amount: acquired});
        vm.roll(block.number + 1);
        _receiver = StickyRewardReceiverFactory(_base.suite.rewardReceiverFactory).predictReceiverOf({
            stickyToken: address(_sticky), groupId: 0
        });
        assertEq(_receiver.code.length, 0, "Rewards can arrive before the receiver is deployed");
    }

    /// @notice The Base-home hook delivers actual Ethereum reserved tokens to its Base pool and holder.
    function test_baseHome_ethereumReservedSplitHookBridgesAndCollects() public {
        _freshBaseRewardRound();
        StickySourceCollector homeCollector = _baseHomeCollector(_base);
        vm.selectFork(_ethereum.forkId);
        StickySourceCollector sourceCollector = _baseHomeCollector(_ethereum);
        assertEq(address(sourceCollector), address(homeCollector), "Base-home hook has one address across both chains");
        assertEq(
            sourceCollector.RECEIVER_FACTORY().predictReceiverOf({stickyToken: address(_sticky), groupId: 0}),
            _receiver,
            "source prediction identifies the Base receiver"
        );
        uint256 reward = _fundCollector({context: _ethereum, collector: sourceCollector});
        JBOutboxTree memory beforeOutbox = _source.outboxOf(JBConstants.NATIVE_TOKEN);
        uint256 supplyBefore = _ethereum.underlying.totalSupply();
        uint256 fee = _SUCKER_REGISTRY.toRemoteFee();
        vm.deal(_keeper, fee);
        vm.recordLogs();
        vm.prank(_keeper);
        // The caller supplies the registry fee; all reward principal belongs to the authenticated split bucket.
        // forge-lint: disable-next-item(arbitrary-send-eth)
        uint256 index = sourceCollector.send{value: fee}({
            sourceProjectId: _ethereum.underlyingProjectId,
            stickyToken: address(_sticky),
            groupId: 0,
            amount: reward,
            sucker: _source,
            backingToken: JBConstants.NATIVE_TOKEN
        });
        Vm.Log[] memory logs = vm.getRecordedLogs();
        JBClaim memory claimData =
            _collectorClaim({logs: logs, collector: sourceCollector, beforeOutbox: beforeOutbox, reward: reward});
        assertEq(index, claimData.leaf.index, "returned index identifies the actual appended reward leaf");
        assertGt(claimData.leaf.terminalTokenAmount, 0, "real reserved tokens reclaim positive backing");
        assertEq(_ethereum.underlying.totalSupply(), supplyBefore - reward, "source project tokens burned once");
        assertEq(_ethereum.underlying.balanceOf(address(sourceCollector)), 0, "source principal delivered");
        assertEq(_ethereum.underlying.balanceOf(_keeper), 0, "keeper receives no reward principal");
        assertEq(_ethereum.underlying.allowance(address(sourceCollector), address(_source)), 0);
        assertEq(sourceCollector.pendingOf(_ethereum.underlyingProjectId, address(_sticky), 0), 0);
        assertEq(sourceCollector.totalPendingOf(_ethereum.underlyingProjectId), 0);
        JBOutboxTree memory afterOutbox = _source.outboxOf(JBConstants.NATIVE_TOKEN);
        assertEq(afterOutbox.tree.count, beforeOutbox.tree.count + 1, "exactly one leaf appended");
        assertGt(afterOutbox.numberOfClaimsSent, index, "the submitted root includes this reward");
        BridgeMessage memory message = _captureMessage({
            logs: logs, claimData: claimData, value: beforeOutbox.balance + claimData.leaf.terminalTokenAmount
        });
        _relay(message);
        uint256 destinationSupplyBefore = _base.underlying.totalSupply();
        vm.prank(_keeper);
        _destination.claim(claimData);
        assertEq(_base.underlying.totalSupply(), destinationSupplyBefore + reward, "same token count reminted on Base");
        assertEq(_base.underlying.balanceOf(_receiver), reward, "only the selected Base receiver receives the reward");
        assertEq(_base.underlying.balanceOf(_keeper), 0);
        assertEq(_settle(), reward, "existing Base receiver funds its local reward ledger");
        assertEq(homeCollector.totalPendingOf(_base.underlyingProjectId), 0, "bridge arrivals bypass source custody");
        _collectToHolder(reward);
    }

    /// @notice A Base source split is queued and permissionlessly settled on its configured home chain without
    /// bridging.
    function test_baseHome_reservedSplitHookSettlesAndCollectsLocally() public {
        _freshBaseRewardRound();
        StickySourceCollector collector = _baseHomeCollector(_base);
        uint256 reward = _fundCollector({context: _base, collector: collector});
        JBOutboxTree memory beforeOutbox = _destination.outboxOf(JBConstants.NATIVE_TOKEN);
        uint256 supplyBefore = _base.underlying.totalSupply();
        vm.prank(_keeper);
        assertEq(
            collector.settle({
                sourceProjectId: _base.underlyingProjectId, stickyToken: address(_sticky), groupId: 0, amount: reward
            }),
            reward
        );
        assertEq(collector.pendingOf(_base.underlyingProjectId, address(_sticky), 0), 0);
        assertEq(collector.totalPendingOf(_base.underlyingProjectId), 0);
        assertEq(_base.underlying.balanceOf(address(collector)), 0);
        assertEq(_base.underlying.balanceOf(_receiver), 0);
        assertEq(_base.underlying.balanceOf(_keeper), 0);
        assertEq(_base.underlying.totalSupply(), supplyBefore, "home settlement does not burn or remint rewards");
        assertEq(
            abi.encode(_destination.outboxOf(JBConstants.NATIVE_TOKEN)),
            abi.encode(beforeOutbox),
            "no local bridge work"
        );
        _collectToHolder(reward);
    }

    /// @notice Claiming before message delivery leaves the valid leaf available for a later retry.
    function test_ethereumProject3ToBaseReceiver_claimBeforeMessageArrivalCanRetry() public {
        (JBClaim memory claimData, BridgeMessage memory message) = _prepareAndSend();
        vm.selectFork(_base.forkId);
        _expectInvalidClaim(claimData);
        _relay(message);
        _destination.claim(claimData);
        assertEq(_base.underlying.balanceOf(_receiver), claimData.leaf.projectTokenCount);
    }

    /// @notice A failed source-side minimum returns the wallet, supply, allowance, treasury, and outbox unchanged.
    function test_ethereumProject3ToBaseReceiver_failedPreparePreservesTokensAndOutbox() public {
        vm.selectFork(_ethereum.forkId);
        // forge-lint: disable-next-line(literal-instead-of-constant)
        uint256 reward = _buyUnderlying({context: _ethereum, holder: _funder, nativeAmount: 0.01 ether});
        JBOutboxTree memory beforeOutbox = _source.outboxOf(JBConstants.NATIVE_TOKEN);
        uint256 supplyBefore = _ethereum.underlying.totalSupply();
        uint256 backingBefore = _ethereum.core.terminal.STORE().balanceOf({
            // forge-lint: disable-next-line(literal-instead-of-constant)
            terminal: address(_ethereum.nativeTerminal),
            // forge-lint: disable-next-line(literal-instead-of-constant)
            projectId: 3,
            token: JBConstants.NATIVE_TOKEN
        });
        vm.startPrank(_funder);
        _ethereum.underlying.approve({spender: address(_source), value: reward});
        vm.expectPartialRevert(JBMultiTerminal.JBMultiTerminal_UnderMin.selector);
        _source.prepare({
            projectTokenCount: reward,
            beneficiary: bytes32(uint256(uint160(_receiver))),
            minTokensReclaimed: type(uint256).max,
            token: JBConstants.NATIVE_TOKEN,
            metadata: bytes32(0)
        });
        vm.stopPrank();
        assertEq(_ethereum.underlying.balanceOf(_funder), reward);
        assertEq(_ethereum.underlying.totalSupply(), supplyBefore);
        assertEq(_ethereum.underlying.allowance(_funder, address(_source)), reward);
        assertEq(
            _ethereum.core.terminal.STORE().balanceOf({
                // forge-lint: disable-next-line(literal-instead-of-constant)
                terminal: address(_ethereum.nativeTerminal),
                // forge-lint: disable-next-line(literal-instead-of-constant)
                projectId: 3,
                token: JBConstants.NATIVE_TOKEN
            }),
            backingBefore
        );
        assertEq(abi.encode(_source.outboxOf(JBConstants.NATIVE_TOKEN)), abi.encode(beforeOutbox));
    }

    /// @notice Messenger replay and duplicate claims cannot mint twice, and repeated empty settlement is harmless.
    function test_ethereumProject3ToBaseReceiver_rejectsMessageReplayAndDoubleClaim() public {
        (JBClaim memory claimData, BridgeMessage memory message) = _prepareAndSend();
        _relay(message);
        vm.expectRevert();
        _deposit(message);
        _destination.claim(claimData);
        vm.expectRevert(
            abi.encodeWithSelector(
                JBSucker.JBSucker_LeafAlreadyExecuted.selector, JBConstants.NATIVE_TOKEN, claimData.leaf.index
            )
        );
        _destination.claim(claimData);
        assertEq(_settle(), claimData.leaf.projectTokenCount);
        assertEq(_settle(), 0);
    }

    /// @notice A keeper cannot redirect a valid claim or change its metadata or proof.
    function test_ethereumProject3ToBaseReceiver_rejectsTamperedBeneficiaryMetadataAndProof() public {
        (JBClaim memory claimData, BridgeMessage memory message) = _prepareAndSend();
        _relay(message);
        bytes32 beneficiary = claimData.leaf.beneficiary;
        claimData.leaf.beneficiary = bytes32(uint256(uint160(_keeper)));
        _expectInvalidClaim(claimData);
        claimData.leaf.beneficiary = beneficiary;
        bytes32 metadata = claimData.leaf.metadata;
        claimData.leaf.metadata = keccak256("forged metadata");
        _expectInvalidClaim(claimData);
        claimData.leaf.metadata = metadata;
        bytes32 sibling = claimData.proof[0];
        claimData.proof[0] = keccak256("forged proof");
        _expectInvalidClaim(claimData);
        claimData.proof[0] = sibling;
        _destination.claim(claimData);
        assertEq(_base.underlying.balanceOf(_receiver), claimData.leaf.projectTokenCount);
        assertEq(_base.underlying.balanceOf(_keeper), 0);
    }

    /// @notice Neither a direct caller, an unauthorized deposit caller, nor a different remote sender can set a root.
    function test_ethereumProject3ToBaseReceiver_rejectsUnauthorizedRelayAndRemoteSender() public {
        (, BridgeMessage memory message) = _prepareAndSend();
        vm.selectFork(_base.forkId);
        bytes32 inboxBefore = _destination.inboxOf(JBConstants.NATIVE_TOKEN).root;
        vm.expectRevert(abi.encodeWithSelector(JBSucker.JBSucker_NotPeer.selector, bytes32(uint256(uint160(_keeper)))));
        vm.prank(_keeper);
        _destination.fromRemote(_messageRoot(message));

        vm.expectRevert();
        vm.prank(_keeper);
        IStickyOPMessenger(_L2_MESSENGER).relayMessage({
            nonce: message.nonce,
            sender: message.sender,
            target: message.target,
            value: message.value,
            minimumGas: message.minimumGas,
            message: message.message
        });
        address source = message.sender;
        message.sender = _keeper;
        _deposit(message);
        assertFalse(IStickyOPMessenger(_L2_MESSENGER).successfulMessages(_messageHash(message)));
        assertEq(_destination.inboxOf(JBConstants.NATIVE_TOKEN).root, inboxBefore);
        message.sender = source;
        _relay(message);
    }

    /// @notice A real cross-chain reward reaches a counterfactual receiver, vests, compounds, and remains redeemable.
    function test_ethereumProject3ToBaseReceiver_settleVestCompoundAndExit() public {
        (JBClaim memory claimData, BridgeMessage memory message) = _prepareAndSend();
        _relay(message);
        uint256 supplyBefore = _base.underlying.totalSupply();
        uint256 backingBefore = _base.core.terminal.STORE().balanceOf({
            terminal: address(_base.nativeTerminal),
            projectId: _base.underlyingProjectId,
            token: JBConstants.NATIVE_TOKEN
        });
        vm.prank(_keeper);
        _destination.claim(claimData);
        assertEq(_base.underlying.totalSupply(), supplyBefore + claimData.leaf.projectTokenCount);
        assertEq(_base.underlying.balanceOf(_receiver), claimData.leaf.projectTokenCount);
        assertEq(_base.underlying.balanceOf(_keeper), 0);
        assertEq(
            _base.core.terminal.STORE().balanceOf({
                terminal: address(_base.nativeTerminal),
                projectId: _base.underlyingProjectId,
                token: JBConstants.NATIVE_TOKEN
            }),
            backingBefore + claimData.leaf.terminalTokenAmount
        );
        assertEq(_receiver.code.length, 0);

        uint256 reward = _settle();
        assertEq(reward, claimData.leaf.projectTokenCount);
        _enableAutoStick();
        _vest();
        StickyDistributor distributor = StickyDistributor(payable(_base.suite.distributor));
        assertEq(
            distributor.collectableFor({
                hook: address(_sticky), tokenId: uint256(uint160(_holder)), token: IERC20(address(_base.underlying))
            }),
            reward
        );
        uint256 sharesBefore = _sticky.balanceOf(_holder);
        vm.prank(_keeper);
        (uint256 compounded, uint256 shares) = StickyAutoStick(_base.suite.autoStick).compoundFor({
            projectId: _stickyProjectId, holder: _holder, groupIds: _defaultGroup()
        });
        assertEq(compounded, reward);
        assertGt(shares, 0);
        assertEq(_sticky.balanceOf(_holder), sharesBefore + shares);
        assertEq(_base.underlying.balanceOf(_keeper), 0);
        assertEq(_sticky.balanceOf(_keeper), 0);
        assertEq(_base.underlying.balanceOf(_base.suite.autoStick), 0);
        assertEq(_base.underlying.allowance(_base.suite.autoStick, address(_base.core.terminal)), 0);
        assertGt(
            _cashOut({
                context: _base,
                projectId: _stickyProjectId,
                holder: _holder,
                count: _sticky.balanceOf(_holder),
                minimum: 1
            }),
            reward
        );
        assertEq(_sticky.balanceOf(_holder), 0);
    }

    //*********************************************************************//
    // ---------------------- internal transactions ---------------------- //
    //*********************************************************************//

    /// @notice Deploys the Base destination family while preserving the six existing local Sticky singletons.
    /// @param context The selected source or home fork and its canonical deployment bindings.
    /// @return collector The shared hook whose immutable destination is Base.
    function _baseHomeCollector(StickyRealProjectContext memory context)
        internal
        returns (StickySourceCollector collector)
    {
        StickyDeploymentHarness deployment = new StickyDeploymentHarness();
        StickyDeploymentAddresses memory deployed =
            deployment.deployFor({core: context.core, destinationChainId: _BASE_CHAIN_ID});
        assertEq(deployed.deployer, context.suite.deployer, "existing deployer preserved");
        assertEq(deployed.hook, context.suite.hook, "existing accounting hook preserved");
        assertEq(deployed.distributor, context.suite.distributor, "existing distributor preserved");
        assertEq(deployed.rewardReceiver, context.suite.rewardReceiver, "existing receiver implementation preserved");
        assertEq(
            deployed.rewardReceiverFactory, context.suite.rewardReceiverFactory, "existing receiver factory preserved"
        );
        assertEq(deployed.autoStick, context.suite.autoStick, "existing compounding adapter preserved");
        collector = StickySourceCollector(deployed.sourceCollector);
        assertEq(collector.DESTINATION_CHAIN_ID(), _BASE_CHAIN_ID);
        assertNotEq(
            address(collector), context.suite.sourceCollector, "Base and Ethereum families have distinct custody"
        );
    }

    /// @notice Vests the Base reward and permissionlessly delivers it only to its actual Sticky holder.
    /// @param reward The expected underlying-token reward funded into the selected Base pool.
    function _collectToHolder(uint256 reward) internal {
        StickyDistributor distributor = StickyDistributor(payable(_base.suite.distributor));
        IERC20 token = IERC20(address(_base.underlying));
        assertEq(distributor.balanceOf(address(_sticky), token), reward, "selected Base pool owns the reward inventory");
        assertEq(_base.underlying.allowance(_receiver, address(distributor)), 0, "receiver approval cleared");
        _enableAutoStick();
        _vest();
        assertEq(distributor.collectableFor(address(_sticky), uint256(uint160(_holder)), token), reward);
        uint256[] memory tokenIds = new uint256[](1);
        tokenIds[0] = uint256(uint160(_holder));
        IERC20[] memory tokens = new IERC20[](1);
        tokens[0] = token;
        uint256 holderBefore = token.balanceOf(_holder);
        vm.prank(_keeper);
        distributor.collectVestedRewards({
            hook: address(_sticky), groupId: 0, tokenIds: tokenIds, tokens: tokens, beneficiary: _holder
        });
        assertEq(token.balanceOf(_holder), holderBefore + reward, "full reserved reward reaches the Base holder");
        assertEq(token.balanceOf(_keeper), 0, "permissionless keeper cannot redirect reward collection");
        assertEq(distributor.balanceOf(address(_sticky), token), 0, "selected reward inventory fully collected");
    }

    /// @notice Models the portal deposit by impersonating its canonical aliased sender and crediting the sent ETH.
    /// @param message The message being deposited, including the original remote sender.
    function _deposit(BridgeMessage memory message) internal {
        address aliasedSender;
        unchecked {
            aliasedSender = address(uint160(_L1_MESSENGER) + _ALIAS_OFFSET);
        }
        vm.deal(aliasedSender, message.value);
        vm.prank(aliasedSender);
        IStickyOPMessenger(_L2_MESSENGER).relayMessage{value: message.value}({
            nonce: message.nonce,
            sender: message.sender,
            target: message.target,
            value: message.value,
            minimumGas: message.minimumGas,
            message: message.message
        });
    }

    /// @notice Gives the adapter only the holder's explicit project trust, token approval, and compounding opt-in.
    function _enableAutoStick() internal {
        vm.startPrank(_holder);
        _base.underlying.approve({spender: _base.suite.autoStick, value: type(uint256).max});
        StickyHook(_base.suite.hook).setTrustedSenderFor({
            projectId: _stickyProjectId, sender: _base.suite.autoStick, trusted: true
        });
        StickyAutoStick(_base.suite.autoStick).setConfigFor({
            projectId: _stickyProjectId, enabled: true, minimumAmount: 1, cooldown: 1 days
        });
        vm.stopPrank();
    }

    /// @notice Checks that a rejected proof neither marks the leaf executed nor delivers reward tokens.
    /// @param claimData The unprovable or tampered claim.
    function _expectInvalidClaim(JBClaim memory claimData) internal {
        vm.expectPartialRevert(JBSucker.JBSucker_InvalidProof.selector);
        _destination.claim(claimData);
        assertEq(_destination.executedLeafHashOf(JBConstants.NATIVE_TOKEN, claimData.leaf.index), bytes32(0));
        assertEq(_base.underlying.balanceOf(_receiver), 0);
    }

    /// @notice Gives the new Base holder a future unpinned reward round without rewriting existing snapshots.
    function _freshBaseRewardRound() internal {
        vm.selectFork(_base.forkId);
        StickyDistributor distributor = StickyDistributor(payable(_base.suite.distributor));
        uint256 round = distributor.currentRound() + 2;
        assertEq(distributor.roundSnapshotBlock(round), 0, "fresh Base snapshot after the holder's stake");
        vm.warp(distributor.roundStartTimestamp(round));
        vm.roll(vm.getBlockNumber() + 1);
    }

    /// @notice Directs actual newly issued reserves to the selected home-family hook through the real controller.
    /// @dev All privileged split changes are local fork setup; the keeper has no project permissions afterwards.
    /// @param context The current fork's real source project and payment terminal.
    /// @param collector The Base-family hook accepting this pool's reserved-token allocation.
    /// @return reward The actual project-token atoms accepted into the selected pool's source bucket.
    function _fundCollector(
        StickyRealProjectContext memory context,
        StickySourceCollector collector
    )
        internal
        returns (uint256 reward)
    {
        // Leave earlier allocations with their existing beneficiaries before configuring the fork-only source.
        uint256 previousReserved = context.core.controller.pendingReservedTokenBalanceOf(context.underlyingProjectId);
        if (previousReserved != 0) {
            vm.prank(_keeper);
            assertEq(
                context.core.controller.sendReservedTokensToSplitsOf({projectId: context.underlyingProjectId}),
                previousReserved
            );
        }
        (JBRuleset memory ruleset,) = context.core.controller.currentRulesetOf(context.underlyingProjectId);
        JBSplit[] memory splits = new JBSplit[](1);
        splits[0] = JBSplit({
            percent: JBConstants.SPLITS_TOTAL_PERCENT,
            projectId: 0,
            beneficiary: payable(address(_sticky)),
            preferAddToBalance: false,
            lockedUntil: 0,
            hook: IJBSplitHook(address(collector))
        });
        JBSplitGroup[] memory groups = new JBSplitGroup[](1);
        groups[0] = JBSplitGroup({groupId: JBSplitGroupIds.RESERVED_TOKENS, splits: splits});
        address owner = context.core.controller.PROJECTS().ownerOf(context.underlyingProjectId);
        assertNotEq(_keeper, owner);
        vm.prank(owner);
        context.core.controller
            .setSplitGroupsOf({projectId: context.underlyingProjectId, rulesetId: ruleset.id, splitGroups: groups});
        // Produce both the holder's tokens and pending reserves through the deployed payment terminal.
        assertGt(_buyUnderlying({context: context, holder: _funder, nativeAmount: 0.01 ether}), 0);
        reward = context.core.controller.pendingReservedTokenBalanceOf(context.underlyingProjectId);
        assertGt(reward, 0, "real payment accrues reserved rewards");
        uint256 supplyBefore = context.underlying.totalSupply();
        assertEq(context.underlying.balanceOf(address(collector)), 0);
        vm.prank(_keeper);
        assertEq(context.core.controller.sendReservedTokensToSplitsOf({projectId: context.underlyingProjectId}), reward);
        assertEq(
            context.underlying.totalSupply(), supplyBefore + reward, "authenticated hook consumes every reserve atom"
        );
        assertEq(context.underlying.balanceOf(address(collector)), reward);
        assertEq(collector.pendingOf(context.underlyingProjectId, address(_sticky), 0), reward);
        assertEq(collector.totalPendingOf(context.underlyingProjectId), reward);
        assertEq(context.underlying.allowance(address(context.core.controller), address(collector)), 0);
    }

    /// @notice Pays Ethereum project 3, burns its real tokens, and captures the actual messenger submission.
    /// @return claimData The newly prepared leaf and its proof against the emitted root.
    /// @return message The complete L1 message to replay at the portal deposit boundary.
    function _prepareAndSend() internal returns (JBClaim memory claimData, BridgeMessage memory message) {
        vm.selectFork(_ethereum.forkId);
        // forge-lint: disable-next-line(literal-instead-of-constant)
        uint256 reward = _buyUnderlying({context: _ethereum, holder: _funder, nativeAmount: 0.01 ether});
        JBOutboxTree memory beforeOutbox = _source.outboxOf(JBConstants.NATIVE_TOKEN);
        claimData =
            _claimFor({beforeOutbox: beforeOutbox, reward: reward, metadata: keccak256("Sticky cross-chain rewards")});
        vm.startPrank(_funder);
        uint256 supplyBefore = _ethereum.underlying.totalSupply();
        _ethereum.underlying.approve({spender: address(_source), value: reward});
        _source.prepare({
            projectTokenCount: reward,
            beneficiary: claimData.leaf.beneficiary,
            minTokensReclaimed: 1,
            token: JBConstants.NATIVE_TOKEN,
            metadata: claimData.leaf.metadata
        });
        vm.stopPrank();
        JBOutboxTree memory afterOutbox = _source.outboxOf(JBConstants.NATIVE_TOKEN);
        claimData.leaf.terminalTokenAmount = afterOutbox.balance - beforeOutbox.balance;
        assertGt(claimData.leaf.terminalTokenAmount, 0);
        assertEq(_ethereum.underlying.balanceOf(_funder), 0);
        assertEq(_ethereum.underlying.totalSupply(), supplyBefore - reward);
        assertEq(afterOutbox.tree.count, beforeOutbox.tree.count + 1);
        uint256 fee = _source.REGISTRY().toRemoteFee();
        vm.deal(_funder, fee);
        vm.recordLogs();
        vm.prank(_funder);
        // forge-lint: disable-next-line(arbitrary-send-eth)
        _source.toRemote{value: fee}(JBConstants.NATIVE_TOKEN);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        message = _captureMessage({logs: logs, claimData: claimData, value: afterOutbox.balance});
    }

    /// @notice Delivers the captured source message through Base's actual cross-domain messenger.
    /// @param message The exact message and value emitted on Ethereum.
    function _relay(BridgeMessage memory message) internal {
        vm.selectFork(_base.forkId);
        _deposit(message);
        assertTrue(IStickyOPMessenger(_L2_MESSENGER).successfulMessages(_messageHash(message)));
        assertEq(_destination.inboxOf(JBConstants.NATIVE_TOKEN).root, _messageRoot(message).remoteRoot.root);
    }

    /// @notice Settles the receiver as an unrelated keeper and checks that its tokens and approval are cleared.
    /// @return amount The reward amount funded into the production distributor.
    function _settle() internal returns (uint256 amount) {
        vm.prank(_keeper);
        amount = StickyRewardReceiverFactory(_base.suite.rewardReceiverFactory).settleFor({
            stickyToken: address(_sticky), groupId: 0, token: IERC20(address(_base.underlying))
        });
        assertEq(_base.underlying.balanceOf(_receiver), 0);
        assertEq(_base.underlying.allowance(_receiver, _base.suite.distributor), 0);
    }

    /// @notice Starts the completed reward round's vesting and advances through the production vesting schedule.
    function _vest() internal {
        StickyDistributor distributor = StickyDistributor(payable(_base.suite.distributor));
        assertEq(distributor.ROUND_DURATION(), 7 days);
        // forge-lint: disable-next-line(literal-instead-of-constant)
        assertEq(distributor.VESTING_ROUNDS(), 4);
        vm.warp(block.timestamp + distributor.ROUND_DURATION() + 1);
        vm.roll(block.number + 1);
        vm.prank(_keeper);
        StickyAutoStick(_base.suite.autoStick).beginVestingFor({
            projectId: _stickyProjectId, holder: _holder, groupIds: _defaultGroup()
        });
        vm.warp(block.timestamp + distributor.ROUND_DURATION() * (distributor.VESTING_ROUNDS() + 1));
        vm.roll(block.number + 1);
    }

    //*********************************************************************//
    // ----------------------- internal helpers -------------------------- //
    //*********************************************************************//

    /// @notice The default reward group, as a one-element list.
    /// @return groupIds The default group.
    function _defaultGroup() internal pure returns (uint256[] memory groupIds) {
        groupIds = new uint256[](1);
    }

    /// @notice Recreates the OP version-1 message hash from the captured relay arguments.
    /// @param message The complete message being relayed.
    /// @return messageHash The hash used by the canonical messenger's replay guard.
    function _messageHash(BridgeMessage memory message) internal pure returns (bytes32 messageHash) {
        return keccak256(
            abi.encodeCall(
                IStickyOPMessenger.relayMessage,
                (message.nonce, message.sender, message.target, message.value, message.minimumGas, message.message)
            )
        );
    }

    /// @notice Decodes the sucker root from the actual messenger calldata after its four-byte selector.
    /// @param message The captured remote call.
    /// @return root The outbox root, bridged value, and source accounting records.
    function _messageRoot(BridgeMessage memory message) internal pure returns (JBMessageRoot memory root) {
        // forge-lint: disable-next-line(literal-instead-of-constant)
        bytes memory arguments = new bytes(message.message.length - 4);
        // forge-lint: disable-next-line(uninitialized-local)
        for (uint256 i; i < arguments.length; i++) {
            // forge-lint: disable-next-line(literal-instead-of-constant)
            arguments[i] = message.message[i + 4];
        }
        return abi.decode(arguments, (JBMessageRoot));
    }

    //*********************************************************************//
    // ------------------------- internal views -------------------------- //
    //*********************************************************************//

    /// @notice Captures the deployed messenger's actual submission and proves it includes the selected reward leaf.
    /// @param logs The logs recorded during source submission.
    /// @param claimData The newly appended leaf and its proof against the submitted root.
    /// @param value The source outbox's actual native-token amount, including prior queued backing.
    /// @return message The complete L1 message to replay at the portal deposit boundary.
    function _captureMessage(
        Vm.Log[] memory logs,
        JBClaim memory claimData,
        uint256 value
    )
        internal
        view
        returns (BridgeMessage memory message)
    {
        bool found;
        // forge-lint: disable-next-line(uninitialized-local)
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != _L1_MESSENGER || logs[i].topics[0] != _SENT_MESSAGE) continue;
            (address sender, bytes memory data, uint256 nonce, uint256 gasLimit) =
                abi.decode(logs[i].data, (address, bytes, uint256, uint256));
            if (sender != address(_source)) continue;
            message = BridgeMessage({
                sender: sender,
                target: address(uint160(uint256(logs[i].topics[1]))),
                message: data,
                nonce: nonce,
                minimumGas: gasLimit,
                value: value
            });
            found = true;
        }
        // forge-lint: disable-next-line(uninitialized-local)
        assertTrue(found, "The deployed L1 messenger must accept the actual sucker message");
        assertEq(message.target, address(_destination));
        JBMessageRoot memory root = _messageRoot(message);
        assertEq(root.amount, message.value);
        assertEq(
            root.remoteRoot.root,
            MerkleLib.branchRoot({
                item: keccak256(
                    abi.encode(
                        claimData.leaf.projectTokenCount,
                        claimData.leaf.terminalTokenAmount,
                        claimData.leaf.beneficiary,
                        claimData.leaf.metadata
                    )
                ),
                branch: claimData.proof,
                index: claimData.leaf.index
            })
        );
        assertEq(_source.outboxOf(JBConstants.NATIVE_TOKEN).balance, 0);
    }

    /// @notice Builds the proof for one appended leaf from the source's actual pre-insertion frontier.
    /// @param beforeOutbox The existing source outbox before the selected reward was prepared.
    /// @param reward The project-token atoms belonging to this reward.
    /// @param metadata The attribution metadata included in the source leaf.
    /// @return claimData The reward leaf and proof, before its actual backing amount is filled in.
    function _claimFor(
        JBOutboxTree memory beforeOutbox,
        uint256 reward,
        bytes32 metadata
    )
        internal
        view
        returns (JBClaim memory claimData)
    {
        claimData.token = JBConstants.NATIVE_TOKEN;
        claimData.leaf = JBLeaf({
            index: beforeOutbox.tree.count,
            beneficiary: bytes32(uint256(uint160(_receiver))),
            projectTokenCount: reward,
            terminalTokenAmount: 0,
            metadata: metadata
        });
        // The prior frontier contains every left sibling needed to prove this newly appended leaf. This works even
        // when the production sucker already has transfers; there is no empty-tree assumption or fabricated root.
        bytes32 zero;
        // forge-lint: disable-next-line(uninitialized-local)
        for (uint256 i; i < 32; i++) {
            // forge-lint: disable-next-line(uninitialized-local)
            claimData.proof[i] = (beforeOutbox.tree.count >> i) & 1 == 1 ? beforeOutbox.tree.branch[i] : zero;
            zero = keccak256(abi.encode(zero, zero));
        }
    }

    /// @notice Reconstructs the exact collector leaf from the real sucker event and validates its actual root.
    /// @param logs The logs recorded during the collector's atomic prepare-and-submit call.
    /// @param collector The Base-family hook that prepared the source reward.
    /// @param beforeOutbox The source's actual frontier before the collector appended its reward.
    /// @param reward The selected bucket's project-token amount.
    /// @return claimData The emitted leaf and proof against the actual updated source root.
    function _collectorClaim(
        Vm.Log[] memory logs,
        StickySourceCollector collector,
        JBOutboxTree memory beforeOutbox,
        uint256 reward
    )
        internal
        view
        returns (JBClaim memory claimData)
    {
        claimData = _claimFor({beforeOutbox: beforeOutbox, reward: reward, metadata: bytes32(0)});
        uint256 found = 0;
        for (uint256 i = 0; i < logs.length; i++) {
            Vm.Log memory entry = logs[i];
            if (entry.emitter != address(_source) || entry.topics.length != 3 || entry.topics[0] != _INSERTED_LEAF) {
                continue;
            }
            assertEq(entry.topics[1], claimData.leaf.beneficiary, "actual source leaf targets the Base pool");
            assertEq(entry.topics[2], bytes32(uint256(uint160(JBConstants.NATIVE_TOKEN))));
            (
                bytes32 hashed,
                uint256 index,
                bytes32 root,
                uint256 projectTokenCount,
                uint256 terminalTokenAmount,
                bytes32 metadata,
                address caller
            ) = abi.decode(entry.data, (bytes32, uint256, bytes32, uint256, uint256, bytes32, address));
            assertEq(index, claimData.leaf.index);
            assertEq(projectTokenCount, reward);
            assertEq(metadata, bytes32(0));
            assertEq(caller, address(collector), "registered source collector prepared the exact reward");
            claimData.leaf.terminalTokenAmount = terminalTokenAmount;
            assertEq(
                hashed,
                keccak256(abi.encode(reward, terminalTokenAmount, claimData.leaf.beneficiary, metadata)),
                "emitted leaf hash binds actual token counts and destination"
            );
            assertEq(root, MerkleLib.branchRoot(hashed, claimData.proof, index));
            found++;
        }
        assertEq(found, 1, "one actual collector reward leaf");
    }
}

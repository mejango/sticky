// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IJBCashOutTerminal} from "@bananapus/core-v6/src/interfaces/IJBCashOutTerminal.sol";
import {IJBController} from "@bananapus/core-v6/src/interfaces/IJBController.sol";
import {IJBDirectory} from "@bananapus/core-v6/src/interfaces/IJBDirectory.sol";
import {IJBSplitHook} from "@bananapus/core-v6/src/interfaces/IJBSplitHook.sol";
import {IJBTerminal} from "@bananapus/core-v6/src/interfaces/IJBTerminal.sol";
import {IJBTokens} from "@bananapus/core-v6/src/interfaces/IJBTokens.sol";
import {JBConstants} from "@bananapus/core-v6/src/libraries/JBConstants.sol";
import {JBFees} from "@bananapus/core-v6/src/libraries/JBFees.sol";
import {JBCashOutHookSpecification} from "@bananapus/core-v6/src/structs/JBCashOutHookSpecification.sol";
import {JBRuleset} from "@bananapus/core-v6/src/structs/JBRuleset.sol";
import {JBSplit} from "@bananapus/core-v6/src/structs/JBSplit.sol";
import {JBSplitHookContext} from "@bananapus/core-v6/src/structs/JBSplitHookContext.sol";
import {JBSucker} from "@bananapus/suckers-v6/src/JBSucker.sol";
import {JBSuckerState} from "@bananapus/suckers-v6/src/enums/JBSuckerState.sol";
import {IJBSucker} from "@bananapus/suckers-v6/src/interfaces/IJBSucker.sol";
import {IJBSuckerRegistry} from "@bananapus/suckers-v6/src/interfaces/IJBSuckerRegistry.sol";
import {JBOutboxTree} from "@bananapus/suckers-v6/src/structs/JBOutboxTree.sol";
import {JBRemoteToken} from "@bananapus/suckers-v6/src/structs/JBRemoteToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Test} from "forge-std/Test.sol";

import {StickyRewardReceiver} from "../src/StickyRewardReceiver.sol";
import {StickyRewardReceiverFactory} from "../src/StickyRewardReceiverFactory.sol";
import {StickySourceCollector} from "../src/StickySourceCollector.sol";
import {StickySourceFeePayer} from "../src/StickySourceFeePayer.sol";
import {IStickyDistributor} from "../src/interfaces/IStickyDistributor.sol";
import {IStickyRewardReceiverFactory} from "../src/interfaces/IStickyRewardReceiverFactory.sol";
import {IStickySourceCollector} from "../src/interfaces/IStickySourceCollector.sol";

import {StickyPricingToken} from "./helpers/StickyPricingToken.sol";
import {StickySourceCaller} from "./helpers/StickySourceCaller.sol";
import {StickySourceController} from "./helpers/StickySourceController.sol";
import {StickySourceDistributor} from "./helpers/StickySourceDistributor.sol";
import {StickySourceFeeTerminal} from "./helpers/StickySourceFeeTerminal.sol";
import {StickySourceSucker} from "./helpers/StickySourceSucker.sol";
import {StickySourceToken} from "./helpers/StickySourceToken.sol";
import {StickySourceTokens} from "./helpers/StickySourceTokens.sol";

/// @notice Attributed reserve custody remains conserved across callbacks, partial delivery and retries.
/// @dev Tokens, credits, controller failure/burn, outboxes and receiver settlement mutate real EVM state. Route
/// registry/directory reads and cashout quotes are configured explicitly; live fork tests own actual bridge proof.
contract StickySourceCollectorTest is Test {
    //*********************************************************************//
    // ------------------------ internal constants ----------------------- //
    //*********************************************************************//

    /// @notice Reserved principal used by deterministic custody cases.
    uint256 internal constant _AMOUNT = 100e18;

    /// @notice The caller-funded registry submission fee.
    uint256 internal constant _FEE = 0.001 ether;

    /// @notice The gross native cashout quote used by ordinary tests.
    uint256 internal constant _PREVIEW = 2 ether;

    /// @notice The caller's fee-project token receipt.
    uint256 internal constant _RECEIPT = 5e18;

    //*********************************************************************//
    // -------------------- internal stored properties ------------------- //
    //*********************************************************************//

    /// @notice The unrelated delivery caller.
    address internal _caller;

    /// @notice The shared source hook under test.
    StickySourceCollector internal _collector;

    /// @notice The current source controller, including caught hook failures.
    StickySourceController internal _controller;

    /// @notice Canonical directory identity whose views are mocked.
    address internal _directory;

    /// @notice Observed destination funding through real receivers.
    StickySourceDistributor internal _distributor;

    /// @notice The real destination receiver factory.
    StickyRewardReceiverFactory internal _factory;

    /// @notice Source project 1's token, also used for fee receipts.
    StickySourceToken internal _one;

    /// @notice Canonical registry identity whose views are mocked.
    address internal _registry;

    /// @notice An arbitrary source project's ERC-20.
    StickySourceToken internal _seventySeven;

    /// @notice The first home-chain holder pool.
    address internal _stickyA;

    /// @notice The second home-chain holder pool.
    address internal _stickyB;

    /// @notice Project 3's ordinary delivery route.
    StickySourceSucker internal _sucker;

    /// @notice The current cashout terminal identity.
    address internal _terminal;

    /// @notice Source project 3's token.
    StickySourceToken internal _three;

    /// @notice Stateful token and credit custody registry.
    StickySourceTokens internal _tokens;

    //*********************************************************************//
    // -------------------------- public views --------------------------- //
    //*********************************************************************//

    /// @notice Deployment binds canonical dependencies and gives only this parent access to its fee child.
    function test_constructorBindsSharedDependencies() public view {
        assertEq(address(_collector.REGISTRY()), _registry);
        assertEq(address(_collector.DIRECTORY()), _directory);
        assertEq(address(_collector.TOKENS()), address(_tokens));
        assertEq(address(_collector.RECEIVER_FACTORY()), address(_factory));
        assertEq(_collector.FEE_PAYER().COLLECTOR(), address(_collector));
        assertEq(_collector.DESTINATION_CHAIN_ID(), 1);
    }

    /// @notice The hook exposes the controller's expected split-hook interface without claiming every interface.
    function test_supportsSplitHookInterface() public view {
        assertTrue(_collector.supportsInterface(type(IJBSplitHook).interfaceId));
        assertTrue(_collector.supportsInterface(type(IERC165).interfaceId));
        assertFalse(_collector.supportsInterface(0xffffffff));
    }

    //*********************************************************************//
    // ----------------------- public transactions ----------------------- //
    //*********************************************************************//

    /// @notice Creates canonical bindings, real receiver custody and three independent source projects.
    function setUp() public {
        vm.chainId(10);
        _caller = makeAddr("permissionless delivery caller");
        _stickyA = makeAddr("home-chain holder pool A");
        _stickyB = makeAddr("home-chain holder pool B");
        _directory = makeAddr("canonical directory");
        _registry = makeAddr("canonical sucker registry");
        _terminal = makeAddr("current cashout terminal");
        vm.etch({target: _directory, newRuntimeBytecode: hex"00"});
        vm.etch({target: _registry, newRuntimeBytecode: hex"00"});
        vm.etch({target: _terminal, newRuntimeBytecode: hex"00"});
        vm.deal({account: _caller, newBalance: 100 ether});
        _tokens = new StickySourceTokens();
        _controller = new StickySourceController(_tokens);
        _one = new StickySourceToken();
        _three = new StickySourceToken();
        _seventySeven = new StickySourceToken();
        _bindProject({projectId: 1, token: _one});
        _bindProject({projectId: 3, token: _three});
        _bindProject({projectId: 77, token: _seventySeven});
        vm.mockCall({
            callee: _registry, data: abi.encodeCall(IJBSuckerRegistry.DIRECTORY, ()), returnData: abi.encode(_directory)
        });
        _mockFee(_FEE);
        _distributor = new StickySourceDistributor();
        StickyRewardReceiver receiver = new StickyRewardReceiver(IStickyDistributor(address(_distributor)));
        _factory = new StickyRewardReceiverFactory(receiver);
        _collector = _newCollector(1);
        _sucker = _newRoute(3);
    }

    /// @notice A destructive incoming-token callback cannot consume prior allocations or conceal a custody decrease.
    function test_acceptanceCustodyDecreasePreservesPriorAllocations() public {
        _queueDefault(200e18);
        _three.setTransferCallback({
            target: address(_three),
            data: abi.encodeCall(StickySourceToken.burn, (address(_collector), 150e18)),
            rejectOnFailure: true
        });
        _queueDefault(_AMOUNT);
        assertEq(
            _controller.rejectionReason(),
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_UnexpectedReceipt.selector,
                uint256(3),
                uint256(200e18),
                uint256(150e18),
                uint256(200e18),
                uint256(200e18)
            )
        );
        assertEq(_controller.rejectedCallbacks(), 1);
        assertEq(_controller.burned(), _AMOUNT);
        assertEq(_collector.totalPendingOf(3), 200e18);
        assertEq(_collector.pendingOf({sourceProjectId: 3, stickyToken: _stickyA, groupId: 0}), 200e18);
        assertEq(_three.balanceOf(address(_collector)), 200e18);
        assertEq(_three.totalSupply(), 200e18);
    }

    /// @notice Acceptance only attributes custody and does not touch terminals or bridge outboxes.
    function test_acceptanceDoesNotDependOnDeliveryReadiness() public {
        _sucker.setRoute({routeState: JBSuckerState.DEPRECATED, chainId: 1, remotePeer: bytes32(uint256(1))});
        _mockTerminal({projectId: 3, backing: JBConstants.NATIVE_TOKEN, terminal: address(0)});
        _queue({projectId: 3, stickyToken: _stickyA, groupId: 0, amount: _AMOUNT});
        assertEq(_collector.pendingOf({sourceProjectId: 3, stickyToken: _stickyA, groupId: 0}), _AMOUNT);
        assertEq(_three.balanceOf(address(_collector)), _AMOUNT);
        assertEq(_sucker.prepareCalls(), 0);
        assertEq(_sucker.sendValue(), 0);
        assertEq(_three.allowance({owner: address(_collector), spender: address(_sucker)}), 0);
    }

    /// @notice Any source project and chain can attribute reserves to distinct home-chain groups.
    function test_acceptanceIsNotRestrictedToFeeOrRevProjects() public {
        vm.chainId(25_555);
        _queue({projectId: 77, stickyToken: _stickyB, groupId: 4000, amount: _AMOUNT});
        assertEq(_collector.pendingOf({sourceProjectId: 77, stickyToken: _stickyB, groupId: 4000}), _AMOUNT);
        assertEq(_collector.totalPendingOf(77), _AMOUNT);
        assertEq(_collector.totalPendingOf(3), 0);
        assertEq(_seventySeven.balanceOf(address(_collector)), _AMOUNT);
    }

    /// @notice Combined custody deltas count nested credits separately from an outer ERC-20 receipt.
    function test_acceptanceNestedCreditsDoNotReduceOuterErc20Allocation() public {
        JBSplitHookContext memory nested = _context({projectId: 3, stickyToken: _stickyB, groupId: 4000, amount: 7e18});
        nested.token = address(0);
        _three.setTransferCallback({
            target: address(_controller),
            data: abi.encodeCall(StickySourceController.distribute, (nested)),
            rejectOnFailure: true
        });
        _queue({projectId: 3, stickyToken: _stickyA, groupId: 0, amount: _AMOUNT});
        assertEq(_collector.pendingOf({sourceProjectId: 3, stickyToken: _stickyA, groupId: 0}), _AMOUNT);
        assertEq(_collector.pendingOf({sourceProjectId: 3, stickyToken: _stickyB, groupId: 4000}), 7e18);
        assertEq(_collector.totalPendingOf(3), _AMOUNT + 7e18);
        assertEq(_tokens.creditBalanceOf({holder: address(_collector), projectId: 3}), 7e18);
        assertEq(_three.balanceOf(address(_collector)), _AMOUNT);
        assertEq(_controller.burned(), 0);
        assertEq(_controller.rejectedCallbacks(), 0);
    }

    /// @notice A valid allocation to another project survives a token-triggered nested distribution.
    function test_acceptanceNestedCrossProjectDoesNotBurnReserves() public {
        JBSplitHookContext memory nested =
            _context({projectId: 77, stickyToken: _stickyB, groupId: 4000, amount: 23e18});
        _three.setTransferCallback({
            target: address(_controller),
            data: abi.encodeCall(StickySourceController.distribute, (nested)),
            rejectOnFailure: true
        });
        _queue({projectId: 3, stickyToken: _stickyA, groupId: 0, amount: _AMOUNT});
        assertEq(_collector.pendingOf({sourceProjectId: 3, stickyToken: _stickyA, groupId: 0}), _AMOUNT);
        assertEq(_collector.pendingOf({sourceProjectId: 77, stickyToken: _stickyB, groupId: 4000}), 23e18);
        assertEq(_three.balanceOf(address(_collector)), _AMOUNT);
        assertEq(_seventySeven.balanceOf(address(_collector)), 23e18);
        assertEq(_controller.acceptedCallbacks(), 2);
        assertEq(_controller.rejectedCallbacks(), 0);
        assertEq(_controller.burned(), 0);
    }

    /// @notice A transfer burn cannot create liabilities larger than the actual ERC-20 receipt.
    function test_acceptanceUsesMeasuredReceipt() public {
        _three.setTransferFee(17e18);
        _queue({projectId: 3, stickyToken: _stickyA, groupId: 0, amount: _AMOUNT});
        assertEq(_collector.pendingOf({sourceProjectId: 3, stickyToken: _stickyA, groupId: 0}), 83e18);
        assertEq(_collector.totalPendingOf(3), 83e18);
        assertEq(_three.balanceOf(address(_collector)), 83e18);
        assertEq(_three.totalSupply(), 83e18);
        assertEq(_controller.burned(), 0);
    }

    /// @notice A controller's cached credits context remains valid after that source deploys its ERC-20.
    function test_cachedCreditContextAcceptedAfterTokenDeployment() public {
        JBSplitHookContext memory context =
            _context({projectId: 77, stickyToken: _stickyA, groupId: 0, amount: _AMOUNT});
        context.token = address(0);
        _controller.distribute(context);
        assertEq(_collector.pendingOf({sourceProjectId: 77, stickyToken: _stickyA, groupId: 0}), _AMOUNT);
        assertEq(_tokens.creditBalanceOf({holder: address(_collector), projectId: 77}), _AMOUNT);
        assertEq(_seventySeven.balanceOf(address(_collector)), 0);
        assertEq(_controller.rejectedCallbacks(), 0);
    }

    /// @notice Missing canonical dependencies cannot establish the shared custody boundary.
    function test_constructorRejectsMissingBindings() public {
        vm.expectRevert(
            abi.encodeWithSelector(StickySourceCollector.StickySourceCollector_InvalidDependency.selector, address(0))
        );
        new StickySourceCollector({
            registry: IJBSuckerRegistry(address(0)),
            tokens: IJBTokens(address(_tokens)),
            receiverFactory: IStickyRewardReceiverFactory(address(_factory)),
            destinationChainId: 1
        });
        vm.expectRevert(
            abi.encodeWithSelector(StickySourceCollector.StickySourceCollector_InvalidDependency.selector, address(0))
        );
        new StickySourceCollector({
            registry: IJBSuckerRegistry(_registry),
            tokens: IJBTokens(address(0)),
            receiverFactory: IStickyRewardReceiverFactory(address(_factory)),
            destinationChainId: 1
        });
        vm.expectRevert(
            abi.encodeWithSelector(StickySourceCollector.StickySourceCollector_InvalidDependency.selector, address(0))
        );
        new StickySourceCollector({
            registry: IJBSuckerRegistry(_registry),
            tokens: IJBTokens(address(_tokens)),
            receiverFactory: IStickyRewardReceiverFactory(address(0)),
            destinationChainId: 1
        });
    }

    /// @notice Every collector must bind a real destination namespace before it can accept any custody.
    function test_constructorRejectsZeroDestinationChain() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_InvalidDestinationChainId.selector, uint256(0)
            )
        );
        _newCollector(0);
    }

    /// @notice Credits and tokens jointly back all buckets while unrelated donated custody remains unassigned.
    function test_creditsAndErc20MaterializationPreserveOtherBuckets() public {
        _tokens.setToken({projectId: 77, token: address(0)});
        _queue({projectId: 77, stickyToken: _stickyA, groupId: 0, amount: _AMOUNT});
        _tokens.seedCredit({holder: address(_collector), projectId: 77, amount: 9e18});
        _tokens.setToken({projectId: 77, token: address(_seventySeven)});
        _queue({projectId: 77, stickyToken: _stickyB, groupId: 4000, amount: 20e18});
        StickySourceSucker route = _newRoute(77);
        _mockPreview({route: route, projectId: 77, amount: 30e18, backing: JBConstants.NATIVE_TOKEN, gross: _PREVIEW});
        _sendTo({
            projectId: 77,
            stickyToken: _stickyA,
            groupId: 0,
            amount: 30e18,
            route: route,
            backing: JBConstants.NATIVE_TOKEN,
            value: _FEE
        });
        assertEq(_collector.pendingOf({sourceProjectId: 77, stickyToken: _stickyA, groupId: 0}), 70e18);
        assertEq(_collector.pendingOf({sourceProjectId: 77, stickyToken: _stickyB, groupId: 4000}), 20e18);
        assertEq(_collector.totalPendingOf(77), 90e18);
        assertEq(_tokens.totalBalanceOf({holder: address(_collector), projectId: 77}), 99e18);
        assertEq(_tokens.creditBalanceOf({holder: address(_collector), projectId: 77}), 99e18);
        assertEq(_seventySeven.balanceOf(address(_collector)), 0);
    }

    /// @notice Queueing credits does not require a token; later partial delivery materializes only its shortfall.
    function test_creditsQueueBeforeTokenAndDeliverAfterDeployment() public {
        _tokens.setToken({projectId: 77, token: address(0)});
        _queue({projectId: 77, stickyToken: _stickyA, groupId: 0, amount: _AMOUNT});
        StickySourceSucker route = _newRoute(77);
        _mockPreview({route: route, projectId: 77, amount: 25e18, backing: JBConstants.NATIVE_TOKEN, gross: _PREVIEW});
        bytes32 beforeState = _stateHash(route);
        vm.expectRevert(
            abi.encodeWithSelector(StickySourceCollector.StickySourceCollector_NoToken.selector, uint256(77))
        );
        _sendTo({
            projectId: 77,
            stickyToken: _stickyA,
            groupId: 0,
            amount: 25e18,
            route: route,
            backing: JBConstants.NATIVE_TOKEN,
            value: _FEE
        });
        assertEq(_stateHash(route), beforeState);
        _tokens.setToken({projectId: 77, token: address(_seventySeven)});
        _sendTo({
            projectId: 77,
            stickyToken: _stickyA,
            groupId: 0,
            amount: 25e18,
            route: route,
            backing: JBConstants.NATIVE_TOKEN,
            value: _FEE
        });
        assertEq(_collector.pendingOf({sourceProjectId: 77, stickyToken: _stickyA, groupId: 0}), 75e18);
        assertEq(_tokens.creditBalanceOf({holder: address(_collector), projectId: 77}), 75e18);
        assertEq(_seventySeven.balanceOf(address(_collector)), 0);
        assertEq(route.principalPrepared(), 25e18);
    }

    /// @notice A nonexistent credit claim cannot manufacture unbacked source liabilities.
    function test_creditsRejectUnbackedContext() public {
        JBSplitHookContext memory context =
            _context({projectId: 77, stickyToken: _stickyA, groupId: 0, amount: _AMOUNT});
        context.token = address(0);
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_InsufficientCustody.selector,
                uint256(77),
                uint256(0),
                _AMOUNT
            )
        );
        _dispatch(context);
        assertEq(_collector.totalPendingOf(77), 0);
    }

    /// @notice Identical source, share-token and group keys in different destination families cannot share custody.
    function test_destinationFamiliesIsolateMatchingBucketKeys() public {
        StickySourceCollector ethereumCollector = _collector;
        _queueDefault(70e18);
        StickySourceCollector baseCollector = _newCollector(8453);
        _collector = baseCollector;
        _queueDefault(_AMOUNT);
        StickySourceSucker baseRoute = _newRoute(3);
        baseRoute.setRoute({routeState: JBSuckerState.ENABLED, chainId: 8453, remotePeer: bytes32(uint256(1))});
        _mockPreview({
            route: baseRoute, projectId: 3, amount: 30e18, backing: JBConstants.NATIVE_TOKEN, gross: _PREVIEW
        });

        // A partial send spends only the family selected by the configured split hook address.
        _sendTo({
            projectId: 3,
            stickyToken: _stickyA,
            groupId: 0,
            amount: 30e18,
            route: baseRoute,
            backing: JBConstants.NATIVE_TOKEN,
            value: _FEE
        });
        assertEq(baseCollector.pendingOf({sourceProjectId: 3, stickyToken: _stickyA, groupId: 0}), 70e18);
        assertEq(ethereumCollector.pendingOf({sourceProjectId: 3, stickyToken: _stickyA, groupId: 0}), 70e18);
        assertEq(_three.balanceOf(address(baseCollector)), 70e18);
        assertEq(_three.balanceOf(address(ethereumCollector)), 70e18);
        assertNotEq(address(baseCollector.FEE_PAYER()), address(ethereumCollector.FEE_PAYER()));

        // The other family's matching bucket cannot cover an attempted overdraft.
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_InsufficientPending.selector,
                uint256(3),
                _stickyA,
                uint256(0),
                uint256(71e18),
                uint256(70e18)
            )
        );
        _sendTo({
            projectId: 3,
            stickyToken: _stickyA,
            groupId: 0,
            amount: 71e18,
            route: baseRoute,
            backing: JBConstants.NATIVE_TOKEN,
            value: _FEE
        });
        _collector = ethereumCollector;
        _mockDefaultPreview(20e18);
        _sendDefault(20e18);
        assertEq(ethereumCollector.totalPendingOf(3), 50e18);
        assertEq(baseCollector.totalPendingOf(3), 70e18);
        assertEq(_three.balanceOf(address(ethereumCollector)), 50e18);
        assertEq(_three.balanceOf(address(baseCollector)), 70e18);
    }

    /// @notice A fee-payment callback can queue more principal into the same hook without a caught burn.
    function test_feeCallbackQueuesSameTokenPrincipalForLaterDelivery() public {
        StickySourceSucker route = _newRoute(1);
        _queue({projectId: 1, stickyToken: _stickyA, groupId: 0, amount: _AMOUNT});
        JBSplitHookContext memory callback = _context({projectId: 1, stickyToken: _stickyA, groupId: 0, amount: 7e18});
        route.setCallback({
            target: address(_controller),
            data: abi.encodeCall(StickySourceController.distribute, (callback)),
            duringPrepare: false
        });
        _mockPreview({route: route, projectId: 1, amount: _AMOUNT, backing: JBConstants.NATIVE_TOKEN, gross: _PREVIEW});
        _sendTo({
            projectId: 1,
            stickyToken: _stickyA,
            groupId: 0,
            amount: _AMOUNT,
            route: route,
            backing: JBConstants.NATIVE_TOKEN,
            value: _FEE
        });
        assertEq(_collector.pendingOf({sourceProjectId: 1, stickyToken: _stickyA, groupId: 0}), 7e18);
        assertEq(_collector.totalPendingOf(1), 7e18);
        assertEq(_one.balanceOf(address(_collector)), 7e18);
        assertEq(_one.balanceOf(_caller), _RECEIPT);
        assertEq(_one.balanceOf(address(_collector.FEE_PAYER())), 0);
        assertEq(_controller.burned(), 0);
        assertEq(_controller.rejectedCallbacks(), 0);
        assertEq(_controller.acceptedCallbacks(), 2);
    }

    /// @notice Underpayment, missing receipt token and old retained credits cannot consume any pending principal.
    function test_feeFailuresPreservePendingCustody() public {
        _queueDefault(_AMOUNT);
        _mockDefaultPreview(_AMOUNT);
        bytes32 beforeState = _stateHash(_sucker);
        vm.expectRevert(
            abi.encodeWithSelector(StickySourceFeePayer.StickySourceFeePayer_InsufficientFee.selector, _FEE - 1, _FEE)
        );
        _sendTo({
            projectId: 3,
            stickyToken: _stickyA,
            groupId: 0,
            amount: _AMOUNT,
            route: _sucker,
            backing: JBConstants.NATIVE_TOKEN,
            value: _FEE - 1
        });
        assertEq(_stateHash(_sucker), beforeState);
        address child = address(_collector.FEE_PAYER());
        _sucker.setRetainedFee({account: child, amount: 1});
        _expectDefaultAtomicRevert(
            abi.encodeWithSelector(
                StickySourceFeePayer.StickySourceFeePayer_RetainedFee.selector, address(_sucker), uint256(1)
            )
        );
        _sucker.setRetainedFee({account: child, amount: 0});
        _sucker.setRetainedTransport({account: child, amount: 1});
        _expectDefaultAtomicRevert(
            abi.encodeWithSelector(
                StickySourceFeePayer.StickySourceFeePayer_RetainedTransportPayment.selector,
                address(_sucker),
                uint256(1)
            )
        );
        _sucker.setRetainedTransport({account: child, amount: 0});
        _tokens.setToken({projectId: 1, token: address(0)});
        _expectDefaultAtomicRevert(
            abi.encodeWithSelector(
                StickySourceFeePayer.StickySourceFeePayer_InvalidFeeToken.selector,
                address(_sucker),
                uint256(1),
                address(0)
            )
        );
    }

    /// @notice Consuming an old fee-token donation makes the whole source submission revert.
    function test_feePayerPreservesDonationFloor() public {
        _queueDefault(_AMOUNT);
        _mockDefaultPreview(_AMOUNT);
        address child = address(_collector.FEE_PAYER());
        _one.mint({account: child, amount: 7e18});
        _sucker.setConsumedDonation(10e18);
        _expectDefaultAtomicRevert(
            abi.encodeWithSelector(
                StickySourceFeePayer.StickySourceFeePayer_DecreasedBalance.selector,
                address(_one),
                uint256(7e18),
                uint256(2e18)
            )
        );
        assertEq(_one.balanceOf(child), 7e18);
    }

    /// @notice Empty-calldata transfers remain rejected so source refunds use their caller-attributed ledgers.
    function test_feePayerRejectsDirectNativeTransfer() public {
        address child = address(_collector.FEE_PAYER());
        vm.prank(_caller);
        (bool success,) = child.call{value: 1}("");
        assertFalse(success);
        assertEq(child.balance, 0);
    }

    /// @notice Only the fixed collector can invoke its dynamic-route fee payer.
    function test_feePayerRejectsOtherCallers() public {
        StickySourceFeePayer child = StickySourceFeePayer(address(_collector.FEE_PAYER()));
        vm.expectRevert(
            abi.encodeWithSelector(StickySourceFeePayer.StickySourceFeePayer_Unauthorized.selector, address(this))
        );
        child.send({
            sucker: JBSucker(payable(address(_sucker))),
            backingToken: JBConstants.NATIVE_TOKEN,
            beneficiary: payable(_caller)
        });

        vm.expectRevert(
            abi.encodeWithSelector(StickySourceFeePayer.StickySourceFeePayer_Unauthorized.selector, address(this))
        );
        child.addFeeRefundToBalance(IJBTerminal(_terminal));
    }

    /// @notice Fee-refund contribution cannot mutate custody while an inbound allocation is being measured.
    function test_feeRefundDuringAcceptanceIsRejected() public {
        vm.chainId(1);
        address child = address(_collector.FEE_PAYER());
        vm.deal({account: child, newBalance: 3 ether});
        _mockTerminal({
            projectId: JBConstants.FEE_BENEFICIARY_PROJECT_ID, backing: JBConstants.NATIVE_TOKEN, terminal: _terminal
        });
        _three.setTransferCallback({
            target: address(_collector),
            data: abi.encodeCall(StickySourceCollector.addFeeRefundToBalance, ()),
            rejectOnFailure: false
        });

        _queueDefault(7e18);

        assertFalse(_three.callbackSucceeded());
        assertEq(
            _three.callbackReason(),
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_InboundTransfer.selector, address(_three), uint256(1)
            )
        );
        assertEq(child.balance, 3 ether);
        assertEq(_terminal.balance, 0);
        assertEq(_collector.totalPendingOf(3), 7e18);
        assertEq(_three.balanceOf(address(_collector)), 7e18);
    }

    /// @notice Fee-refund contribution remains blocked at every nested inbound-allocation depth.
    function test_feeRefundDuringNestedAcceptanceIsRejected() public {
        vm.chainId(1);
        address child = address(_collector.FEE_PAYER());
        vm.deal({account: child, newBalance: 3 ether});
        _mockTerminal({
            projectId: JBConstants.FEE_BENEFICIARY_PROJECT_ID, backing: JBConstants.NATIVE_TOKEN, terminal: _terminal
        });
        _seventySeven.setTransferCallback({
            target: address(_collector),
            data: abi.encodeCall(StickySourceCollector.addFeeRefundToBalance, ()),
            rejectOnFailure: false
        });
        JBSplitHookContext memory nested = _context({projectId: 77, stickyToken: _stickyB, groupId: 4000, amount: 7e18});
        _three.setTransferCallback({
            target: address(_controller),
            data: abi.encodeCall(StickySourceController.distribute, (nested)),
            rejectOnFailure: true
        });

        _queueDefault(_AMOUNT);

        assertFalse(_seventySeven.callbackSucceeded());
        assertEq(
            _seventySeven.callbackReason(),
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_InboundTransfer.selector, address(_seventySeven), uint256(2)
            )
        );
        assertEq(child.balance, 3 ether);
        assertEq(_terminal.balance, 0);
        assertEq(_collector.pendingOf(3, _stickyA, 0), _AMOUNT);
        assertEq(_collector.pendingOf(77, _stickyB, 4000), 7e18);
        assertEq(_three.balanceOf(address(_collector)), _AMOUNT);
        assertEq(_seventySeven.balanceOf(address(_collector)), 7e18);
    }

    /// @notice Any keeper can contribute the destination child's complete native balance only to project 1.
    function test_feeRefundFundsFixedProjectOneBalance() public {
        assertEq(JBConstants.FEE_BENEFICIARY_PROJECT_ID, 1, "canonical fee beneficiary is project 1");
        vm.chainId(1);
        address child = address(_collector.FEE_PAYER());
        uint256 amount = 3 ether;
        vm.deal({account: child, newBalance: amount});
        _mockTerminal({
            projectId: JBConstants.FEE_BENEFICIARY_PROJECT_ID, backing: JBConstants.NATIVE_TOKEN, terminal: _terminal
        });
        bytes memory terminalCall = abi.encodeCall(
            IJBTerminal.addToBalanceOf,
            (JBConstants.FEE_BENEFICIARY_PROJECT_ID, JBConstants.NATIVE_TOKEN, amount, false, "", bytes(""))
        );
        vm.expectCall(_terminal, amount, terminalCall);
        vm.expectEmit(true, false, false, true, address(_collector));
        emit IStickySourceCollector.AddFeeRefundToBalance({
            terminal: IJBTerminal(_terminal), amount: amount, caller: _caller
        });

        vm.prank(_caller);
        assertEq(_collector.addFeeRefundToBalance(), amount);

        assertEq(child.balance, 0);
        assertEq(_terminal.balance, amount);
    }

    /// @notice Each contribution resolves project 1's current primary native terminal instead of caching a route.
    function test_feeRefundResolvesRotatedTerminalPerCall() public {
        vm.chainId(1);
        address child = address(_collector.FEE_PAYER());
        uint256 firstAmount = 1 ether;
        uint256 secondAmount = 2 ether;
        _mockTerminal({
            projectId: JBConstants.FEE_BENEFICIARY_PROJECT_ID, backing: JBConstants.NATIVE_TOKEN, terminal: _terminal
        });
        vm.deal({account: child, newBalance: firstAmount});
        assertEq(_collector.addFeeRefundToBalance(), firstAmount);

        address rotatedTerminal = makeAddr("rotated project-1 terminal");
        vm.etch({target: rotatedTerminal, newRuntimeBytecode: hex"00"});
        vm.clearMockedCalls();
        _mockTerminal({
            projectId: JBConstants.FEE_BENEFICIARY_PROJECT_ID,
            backing: JBConstants.NATIVE_TOKEN,
            terminal: rotatedTerminal
        });
        vm.deal({account: child, newBalance: secondAmount});
        assertEq(_collector.addFeeRefundToBalance(), secondAmount);

        assertEq(_terminal.balance, firstAmount);
        assertEq(rotatedTerminal.balance, secondAmount);
        assertEq(child.balance, 0);
    }

    /// @notice A terminal callback cannot recursively spend or duplicate the child's fee contribution.
    function test_feeRefundReentryIsBlocked() public {
        vm.chainId(1);
        address child = address(_collector.FEE_PAYER());
        uint256 amount = 3 ether;
        vm.deal({account: child, newBalance: amount});
        StickySourceFeeTerminal terminal = new StickySourceFeeTerminal(IStickySourceCollector(address(_collector)));
        _mockTerminal({
            projectId: JBConstants.FEE_BENEFICIARY_PROJECT_ID,
            backing: JBConstants.NATIVE_TOKEN,
            terminal: address(terminal)
        });

        vm.prank(_caller);
        assertEq(_collector.addFeeRefundToBalance(), amount);

        assertFalse(terminal.reentrySucceeded());
        assertEq(
            terminal.reentryReason(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
        );
        assertEq(child.balance, 0);
        assertEq(address(terminal).balance, amount);
    }

    /// @notice Only the destination copy can contribute an unattributed raw native balance.
    function test_feeRefundRejectsSourceChain() public {
        address child = address(_collector.FEE_PAYER());
        vm.deal({account: child, newBalance: 3 ether});
        vm.prank(_caller);
        vm.expectRevert(
            abi.encodeWithSelector(StickySourceCollector.StickySourceCollector_DestinationOnly.selector, uint256(10))
        );
        _collector.addFeeRefundToBalance();
        assertEq(child.balance, 3 ether);
    }

    /// @notice A rejected project-1 contribution reverts atomically and keeps the full refund retryable.
    function test_feeRefundTerminalFailurePreservesBalance() public {
        vm.chainId(1);
        address child = address(_collector.FEE_PAYER());
        uint256 amount = 3 ether;
        vm.deal({account: child, newBalance: amount});
        _mockTerminal({
            projectId: JBConstants.FEE_BENEFICIARY_PROJECT_ID, backing: JBConstants.NATIVE_TOKEN, terminal: _terminal
        });
        bytes memory terminalCall = abi.encodeCall(
            IJBTerminal.addToBalanceOf,
            (JBConstants.FEE_BENEFICIARY_PROJECT_ID, JBConstants.NATIVE_TOKEN, amount, false, "", bytes(""))
        );
        vm.mockCallRevert({callee: _terminal, data: terminalCall, revertData: hex"deadbeef"});
        vm.prank(_caller);
        vm.expectRevert(bytes(hex"deadbeef"));
        _collector.addFeeRefundToBalance();
        assertEq(child.balance, amount);
    }

    /// @notice An empty destination child is a no-op without requiring a configured project-1 terminal.
    function test_feeRefundWithNoBalanceIsNoOp() public {
        vm.chainId(1);
        vm.prank(_caller);
        assertEq(_collector.addFeeRefundToBalance(), 0);
    }

    /// @notice Missing destination routing preserves the full refund for a later permissionless attempt.
    function test_feeRefundWithoutTerminalPreservesBalance() public {
        vm.chainId(1);
        address child = address(_collector.FEE_PAYER());
        vm.deal({account: child, newBalance: 3 ether});
        _mockTerminal({
            projectId: JBConstants.FEE_BENEFICIARY_PROJECT_ID, backing: JBConstants.NATIVE_TOKEN, terminal: address(0)
        });
        vm.prank(_caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_NoTerminal.selector,
                JBConstants.FEE_BENEFICIARY_PROJECT_ID,
                JBConstants.NATIVE_TOKEN
            )
        );
        _collector.addFeeRefundToBalance();
        assertEq(child.balance, 3 ether);
    }

    /// @notice A non-contract terminal identity cannot consume the refund and leaves it retryable.
    function test_feeRefundWithoutTerminalCodePreservesBalance() public {
        vm.chainId(1);
        address child = address(_collector.FEE_PAYER());
        vm.deal({account: child, newBalance: 3 ether});
        _mockTerminal({
            projectId: JBConstants.FEE_BENEFICIARY_PROJECT_ID,
            backing: JBConstants.NATIVE_TOKEN,
            terminal: makeAddr("terminal without code")
        });
        vm.prank(_caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_NoTerminal.selector,
                JBConstants.FEE_BENEFICIARY_PROJECT_ID,
                JBConstants.NATIVE_TOKEN
            )
        );
        _collector.addFeeRefundToBalance();
        assertEq(child.balance, 3 ether);
    }

    /// @notice Rejected receipt transfers and failed or incomplete refunds unwind the entire send.
    function test_feeSettlementFailuresAreAtomic() public {
        _queueDefault(_AMOUNT);
        _mockDefaultPreview(_AMOUNT);
        _sucker.setBehavior({failFee: true, failTransport: false, leaveUnsent: false, receipt: 0, transportRefund: 0});
        _sucker.setRefundBehavior({failFeeRefund: true, failTransportRefund: false, residual: false});
        _expectDefaultAtomicRevert(abi.encodeWithSelector(StickySourceSucker.StickySourceSucker_Rejected.selector));
        _sucker.setRefundBehavior({failFeeRefund: false, failTransportRefund: false, residual: true});
        _expectDefaultAtomicRevert(
            abi.encodeWithSelector(
                StickySourceFeePayer.StickySourceFeePayer_RetainedFee.selector, address(_sucker), uint256(1)
            )
        );
        _sucker.setRefundBehavior({failFeeRefund: false, failTransportRefund: false, residual: false});
        _sucker.setBehavior({
            failFee: false, failTransport: false, leaveUnsent: false, receipt: _RECEIPT, transportRefund: 0
        });
        vm.mockCallRevert({
            callee: address(_one),
            data: abi.encodeCall(IERC20.transfer, (_caller, _RECEIPT)),
            revertData: abi.encodeWithSelector(StickySourceSucker.StickySourceSucker_Rejected.selector)
        });
        _expectDefaultAtomicRevert(abi.encodeWithSelector(StickySourceSucker.StickySourceSucker_Rejected.selector));
    }

    /// @notice A claim returning no ERC-20 tokens cannot silently consume a queued credit allocation.
    function test_materializationDeltaMustMatchClaim() public {
        _tokens.setToken({projectId: 77, token: address(0)});
        _queue({projectId: 77, stickyToken: _stickyA, groupId: 0, amount: _AMOUNT});
        _tokens.setToken({projectId: 77, token: address(_seventySeven)});
        StickySourceSucker route = _newRoute(77);
        _mockPreview({route: route, projectId: 77, amount: _AMOUNT, backing: JBConstants.NATIVE_TOKEN, gross: _PREVIEW});
        vm.mockCall({
            callee: address(_controller),
            data: abi.encodeCall(IJBController.claimTokensFor, (address(_collector), 77, _AMOUNT, address(_collector))),
            returnData: ""
        });
        bytes32 beforeState = _stateHash(route);
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_UnexpectedClaimBalance.selector,
                uint256(77),
                _AMOUNT,
                uint256(0)
            )
        );
        _sendTo({
            projectId: 77,
            stickyToken: _stickyA,
            groupId: 0,
            amount: _AMOUNT,
            route: route,
            backing: JBConstants.NATIVE_TOKEN,
            value: _FEE
        });
        assertEq(_stateHash(route), beforeState);
    }

    /// @notice The refund beneficiary cannot initiate another delivery while its first delivery is active.
    function test_refundReentryIsBlocked() public {
        _queueDefault(_AMOUNT);
        _mockDefaultPreview(_AMOUNT);
        _sucker.setBehavior({failFee: true, failTransport: false, leaveUnsent: false, receipt: 0, transportRefund: 0});
        StickySourceCaller caller = new StickySourceCaller();
        caller.configure({reject: false, target: address(_collector), data: _sendData(1)});
        vm.deal({account: address(this), newBalance: _FEE});
        caller.execute{value: _FEE}({target: address(_collector), data: _sendData(_AMOUNT)});
        assertEq(caller.refunded(), _FEE);
        assertFalse(caller.reentrySucceeded());
        assertEq(caller.reentryReason(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
        assertEq(_sucker.prepareCalls(), 1);
    }

    /// @notice Refund rejection cannot strand a prepared leaf and a later unrelated caller can retry.
    function test_refundRejectionRollsBackAndAllowsRetry() public {
        _queueDefault(_AMOUNT);
        _mockDefaultPreview(_AMOUNT);
        _sucker.setBehavior({failFee: true, failTransport: false, leaveUnsent: false, receipt: 0, transportRefund: 0});
        StickySourceCaller caller = new StickySourceCaller();
        caller.configure({reject: true, target: address(0), data: ""});
        vm.deal({account: address(this), newBalance: _FEE});
        bytes32 beforeState = _stateHash(_sucker);
        vm.expectRevert(StickySourceSucker.StickySourceSucker_Rejected.selector);
        caller.execute{value: _FEE}({target: address(_collector), data: _sendData(_AMOUNT)});
        assertEq(_stateHash(_sucker), beforeState);
        assertEq(caller.refunded(), 0);
        _sendDefault(_AMOUNT);
        assertEq(_collector.totalPendingOf(3), 0);
        assertEq(_sucker.outboxOf(JBConstants.NATIVE_TOKEN).numberOfClaimsSent, 1);
    }

    /// @notice The controller fixture exposes the real burn consequence of a rejected reserve hook allocation.
    function test_rejectedSplitBurnsUnconsumedAllocation() public {
        JBSplitHookContext memory context = _context({projectId: 3, stickyToken: _stickyA, groupId: 0, amount: _AMOUNT});
        context.groupId = 42;
        _controller.distribute(context);
        assertEq(_controller.rejectedCallbacks(), 1);
        assertEq(_controller.burned(), _AMOUNT);
        assertEq(_three.totalSupply(), 0);
        assertEq(_collector.totalPendingOf(3), 0);
    }

    /// @notice Reserve-group, hook, decimal, token and destination mismatches fail before accepting custody.
    function test_rejectsMalformedSplitContexts() public {
        JBSplitHookContext memory context = _context({projectId: 3, stickyToken: _stickyA, groupId: 0, amount: _AMOUNT});
        context.groupId = 42;
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_InvalidSplit.selector,
                uint256(3),
                uint256(42),
                address(_collector),
                uint256(18)
            )
        );
        _dispatch(context);
        context.groupId = 1;
        context.split.hook = IJBSplitHook(_caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_InvalidSplit.selector,
                uint256(3),
                uint256(1),
                _caller,
                uint256(18)
            )
        );
        _dispatch(context);
        context.split.hook = IJBSplitHook(address(_collector));
        context.decimals = 6;
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_InvalidSplit.selector,
                uint256(3),
                uint256(1),
                address(_collector),
                uint256(6)
            )
        );
        _dispatch(context);
        context.decimals = 18;
        context.token = address(_one);
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_TokenMismatch.selector,
                uint256(3),
                address(_one),
                address(_three)
            )
        );
        _dispatch(context);
        context.token = address(_three);
        context.split.beneficiary = payable(address(0));
        vm.expectRevert(
            abi.encodeWithSelector(
                StickyRewardReceiverFactory.StickyRewardReceiverFactory_InvalidStickyToken.selector, address(0)
            )
        );
        _dispatch(context);
        context.split.beneficiary = payable(_stickyA);
        context.split.projectId = 666;
        vm.expectRevert(
            abi.encodeWithSelector(
                StickyRewardReceiverFactory.StickyRewardReceiverFactory_InvalidGroupId.selector, uint256(666)
            )
        );
        _dispatch(context);
        assertEq(_collector.totalPendingOf(3), 0);
        assertEq(_three.totalSupply(), 0);
    }

    /// @notice Reserve acceptance cannot silently retain a caller's native currency.
    function test_rejectsNativeValueDuringAcceptance() public {
        JBSplitHookContext memory context = _context({projectId: 3, stickyToken: _stickyA, groupId: 0, amount: _AMOUNT});
        vm.deal({account: address(_controller), newBalance: 1});
        vm.prank(address(_controller));
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_UnexpectedNativeValue.selector, uint256(1)
            )
        );
        _collector.processSplitWith{value: 1}(context);
        assertEq(address(_collector).balance, 0);
        assertEq(_collector.totalPendingOf(3), 0);
    }

    /// @notice Home-chain sends use local settlement and remote chains cannot execute that settlement.
    function test_rejectsWrongDeliveryChain() public {
        _queueDefault(_AMOUNT);
        bytes32 beforeState = _stateHash(_sucker);
        vm.expectRevert(
            abi.encodeWithSelector(StickySourceCollector.StickySourceCollector_DestinationOnly.selector, uint256(10))
        );
        _collector.settle({sourceProjectId: 3, stickyToken: _stickyA, groupId: 0, amount: 1});
        assertEq(_stateHash(_sucker), beforeState);
        vm.chainId(1);
        vm.expectRevert(
            abi.encodeWithSelector(StickySourceCollector.StickySourceCollector_SourceOnly.selector, uint256(1))
        );
        _sendDefault(1);
        assertEq(_stateHash(_sucker), beforeState);
    }

    /// @notice Only the current controller may attribute a source project's custody.
    function test_requiresCurrentController() public {
        JBSplitHookContext memory context = _context({projectId: 3, stickyToken: _stickyA, groupId: 0, amount: _AMOUNT});
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_Unauthorized.selector,
                uint256(3),
                address(this),
                address(_controller)
            )
        );
        _collector.processSplitWith(context);
        StickySourceController next = new StickySourceController(_tokens);
        _tokens.setController({projectId: 3, controller: address(next)});
        vm.mockCall({
            callee: _directory,
            data: abi.encodeCall(IJBDirectory.controllerOf, (3)),
            returnData: abi.encode(address(next))
        });
        _controller.distribute(context);
        assertEq(_controller.burned(), _AMOUNT);
        assertEq(_collector.pendingOf({sourceProjectId: 3, stickyToken: _stickyA, groupId: 0}), 0);
        next.distribute(context);
        assertEq(_collector.pendingOf({sourceProjectId: 3, stickyToken: _stickyA, groupId: 0}), _AMOUNT);
        assertEq(next.rejectedCallbacks(), 0);
    }

    /// @notice Only attributed positive amounts can leave a selected destination bucket.
    function test_sendCannotSpendAnotherBucketOrDonations() public {
        _queueDefault(20e18);
        _queue({projectId: 3, stickyToken: _stickyB, groupId: 4000, amount: 30e18});
        _three.mint({account: address(_collector), amount: _AMOUNT});
        bytes32 beforeState = _stateHash(_sucker);
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_InsufficientPending.selector,
                uint256(3),
                _stickyA,
                uint256(0),
                uint256(21e18),
                uint256(20e18)
            )
        );
        _sendDefault(21e18);
        vm.expectRevert(
            abi.encodeWithSelector(StickySourceCollector.StickySourceCollector_InvalidAmount.selector, uint256(0))
        );
        _sendDefault(0);
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_InsufficientPending.selector,
                uint256(3),
                _stickyA,
                uint256(4000),
                uint256(1),
                uint256(0)
            )
        );
        _sendTo({
            projectId: 3,
            stickyToken: _stickyA,
            groupId: 4000,
            amount: 1,
            route: _sucker,
            backing: JBConstants.NATIVE_TOKEN,
            value: _FEE
        });
        assertEq(_stateHash(_sucker), beforeState);
        assertEq(_three.balanceOf(address(_collector)), 150e18);
    }

    /// @notice Callback-driven outgoing calls cannot consume inventory while incoming custody is being measured.
    function test_sendDuringAcceptanceIsRejected() public {
        _queueDefault(_AMOUNT);
        _three.setTransferCallback({target: address(_collector), data: _sendData(1), rejectOnFailure: false});
        _queueDefault(7e18);
        assertFalse(_three.callbackSucceeded());
        assertEq(
            _three.callbackReason(),
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_InboundTransfer.selector, address(_three), uint256(1)
            )
        );
        assertEq(_collector.pendingOf({sourceProjectId: 3, stickyToken: _stickyA, groupId: 0}), _AMOUNT + 7e18);
        assertEq(_three.balanceOf(address(_collector)), _AMOUNT + 7e18);
        assertEq(_sucker.prepareCalls(), 0);
    }

    /// @notice A mapped ERC-20 backing route uses its own units and mapping rather than a native-token restriction.
    function test_sendGenericMappedBacking() public {
        StickyPricingToken backing = new StickyPricingToken(6);
        _sucker.setMapping({
            backing: address(backing),
            remoteToken: JBRemoteToken({enabled: true, emergencyHatch: false, minGas: 123, addr: bytes32(uint256(456))})
        });
        _mockTerminal({projectId: 3, backing: address(backing), terminal: _terminal});
        _queueDefault(_AMOUNT);
        _mockPreview({route: _sucker, projectId: 3, amount: _AMOUNT, backing: address(backing), gross: 2_500_000});
        _sendTo({
            projectId: 3,
            stickyToken: _stickyA,
            groupId: 0,
            amount: _AMOUNT,
            route: _sucker,
            backing: address(backing),
            value: _FEE
        });
        assertEq(_sucker.tokenPrepared(), address(backing));
        assertEq(_sucker.tokenSent(), address(backing));
        assertEq(_sucker.minimumPrepared(), 2_500_000 - JBFees.standardFeeAmountFrom(2_500_000));
        assertEq(_sucker.outboxOf(address(backing)).numberOfClaimsSent, 1);
        assertEq(_sucker.outboxOf(JBConstants.NATIVE_TOKEN).tree.count, 0);
    }

    /// @notice Partial delivery preserves other destinations, projects and unsolicited source-token donations.
    function test_sendPartialBucketPreservesAllOtherCustody() public {
        _queueDefault(_AMOUNT);
        _queue({projectId: 3, stickyToken: _stickyB, groupId: 4000, amount: 200e18});
        _queue({projectId: 77, stickyToken: _stickyA, groupId: 0, amount: 50e18});
        _three.mint({account: address(_collector), amount: 13e18});
        _mockDefaultPreview(40e18);
        _sendDefault(40e18);
        assertEq(_collector.pendingOf({sourceProjectId: 3, stickyToken: _stickyA, groupId: 0}), 60e18);
        assertEq(_collector.pendingOf({sourceProjectId: 3, stickyToken: _stickyB, groupId: 4000}), 200e18);
        assertEq(_collector.totalPendingOf(3), 260e18);
        assertEq(_three.balanceOf(address(_collector)), 273e18);
        assertEq(_collector.pendingOf({sourceProjectId: 77, stickyToken: _stickyA, groupId: 0}), 50e18);
        assertEq(_seventySeven.balanceOf(address(_collector)), 50e18);
        assertEq(
            _sucker.beneficiaryPrepared(),
            bytes32(uint256(uint160(_factory.predictReceiverOf({stickyToken: _stickyA, groupId: 0}))))
        );
        assertEq(_sucker.allowanceAtPrepare(), 40e18);
        assertEq(_sucker.allowanceAtSend(), 0);
        assertEq(_three.allowance({owner: address(_collector), spender: address(_sucker)}), 0);
    }

    /// @notice An upstream capacity rejection does not prevent a caller from retrying with smaller partial amounts.
    function test_sendPartialRetryAfterUpstreamCapacityRejection() public {
        _queueDefault(_AMOUNT);
        _mockDefaultPreview(_AMOUNT);
        vm.mockCallRevert({
            callee: address(_sucker),
            data: abi.encodeCall(
                IJBSucker.prepare,
                (
                    _AMOUNT,
                    bytes32(uint256(uint160(_factory.predictReceiverOf({stickyToken: _stickyA, groupId: 0})))),
                    _PREVIEW - JBFees.standardFeeAmountFrom(_PREVIEW),
                    JBConstants.NATIVE_TOKEN,
                    bytes32(0)
                )
            ),
            revertData: abi.encodeWithSelector(StickySourceSucker.StickySourceSucker_Rejected.selector)
        });
        bytes32 beforeState = _stateHash(_sucker);
        vm.expectRevert(StickySourceSucker.StickySourceSucker_Rejected.selector);
        _sendDefault(_AMOUNT);
        assertEq(_stateHash(_sucker), beforeState);
        _mockDefaultPreview(40e18);
        _sendDefault(40e18);
        assertEq(_collector.pendingOf({sourceProjectId: 3, stickyToken: _stickyA, groupId: 0}), 60e18);
    }

    /// @notice Canonical registry, directory, token and source bindings cannot be replaced by self-reported routes.
    function test_sendRejectsForgedBindings() public {
        _queueDefault(_AMOUNT);
        _mockDefaultPreview(_AMOUNT);
        _registerRoute({route: _sucker, projectId: 3, registered: false});
        _expectDefaultAtomicRevert(_invalidRouteError());
        _registerRoute({route: _sucker, projectId: 3, registered: true});
        string[3] memory getters = ["REGISTRY()", "DIRECTORY()", "TOKENS()"];
        address[3] memory originals = [_registry, _directory, address(_tokens)];
        for (uint256 i; i < getters.length; i++) {
            vm.mockCall({
                callee: address(_sucker), data: abi.encodeWithSignature(getters[i]), returnData: abi.encode(_caller)
            });
            _expectDefaultAtomicRevert(_invalidRouteError());
            vm.mockCall({
                callee: address(_sucker),
                data: abi.encodeWithSignature(getters[i]),
                returnData: abi.encode(originals[i])
            });
        }
        vm.mockCall({
            callee: address(_sucker), data: abi.encodeCall(IJBSucker.projectId, ()), returnData: abi.encode(uint256(77))
        });
        _expectDefaultAtomicRevert(_invalidRouteError());
    }

    /// @notice A loss of aggregate custody cannot let one bucket spend backing owed to another destination.
    function test_sendRejectsInsolventAggregateCustody() public {
        _queueDefault(20e18);
        _queue({projectId: 3, stickyToken: _stickyB, groupId: 4000, amount: 80e18});
        _three.burn({account: address(_collector), amount: 1e18});
        _mockDefaultPreview(1e18);
        bytes32 beforeState = _stateHash(_sucker);
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_InsufficientCustody.selector,
                uint256(3),
                uint256(99e18),
                uint256(100e18)
            )
        );
        _sendDefault(1e18);
        assertEq(_stateHash(_sucker), beforeState);
        assertEq(_sucker.prepareCalls(), 0);
    }

    /// @notice Mapping, peer and lifecycle failures restore the queued bucket before any delivery commits.
    function test_sendRejectsInvalidRouteStates() public {
        _queueDefault(_AMOUNT);
        _mockDefaultPreview(_AMOUNT);
        _sucker.setRoute({routeState: JBSuckerState.ENABLED, chainId: 10, remotePeer: bytes32(uint256(1))});
        _expectDefaultAtomicRevert(_invalidRouteError());
        _sucker.setRoute({routeState: JBSuckerState.ENABLED, chainId: 1, remotePeer: bytes32(0)});
        _expectDefaultAtomicRevert(_invalidRouteError());
        _sucker.setRoute({routeState: JBSuckerState.DEPRECATED, chainId: 1, remotePeer: bytes32(uint256(1))});
        _expectDefaultAtomicRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_SuckerNotSending.selector,
                address(_sucker),
                JBSuckerState.DEPRECATED
            )
        );
        _sucker.setRoute({routeState: JBSuckerState.ENABLED, chainId: 1, remotePeer: bytes32(uint256(1))});
        _sucker.setMapping({
            backing: JBConstants.NATIVE_TOKEN,
            remoteToken: JBRemoteToken({enabled: false, emergencyHatch: false, minGas: 0, addr: bytes32(uint256(1))})
        });
        _expectDefaultAtomicRevert(_invalidMappingError());
        _sucker.setMapping({
            backing: JBConstants.NATIVE_TOKEN,
            remoteToken: JBRemoteToken({enabled: true, emergencyHatch: true, minGas: 0, addr: bytes32(uint256(1))})
        });
        _expectDefaultAtomicRevert(_invalidMappingError());
        _sucker.setMapping({
            backing: JBConstants.NATIVE_TOKEN,
            remoteToken: JBRemoteToken({enabled: true, emergencyHatch: false, minGas: 0, addr: bytes32(0)})
        });
        _expectDefaultAtomicRevert(_invalidMappingError());
    }

    /// @notice A missing current backing terminal cannot destroy accepted reserves.
    function test_sendRejectsMissingTerminal() public {
        _queueDefault(_AMOUNT);
        _mockTerminal({projectId: 3, backing: JBConstants.NATIVE_TOKEN, terminal: address(0)});
        _expectDefaultAtomicRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_NoTerminal.selector, uint256(3), JBConstants.NATIVE_TOKEN
            )
        );
    }

    /// @notice Reentry from either preparation or fee payment cannot consume a second queued allocation.
    function test_sendRejectsOutgoingReentry() public {
        _queueDefault(_AMOUNT);
        _mockDefaultPreview(50e18);
        _sucker.setCallback({target: address(_collector), data: _sendData(1), duringPrepare: true});
        _sendDefault(50e18);
        assertFalse(_sucker.callbackSucceeded());
        assertEq(
            _sucker.callbackReason(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
        );
        _sucker.setCallback({target: address(_collector), data: _sendData(1), duringPrepare: false});
        _sendDefault(50e18);
        assertFalse(_sucker.callbackSucceeded());
        assertEq(
            _sucker.callbackReason(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
        );
        assertEq(_sucker.prepareCalls(), 2);
        assertEq(_collector.totalPendingOf(3), 0);
    }

    /// @notice A caller can replace a retired registered route while keeping the same attributed inventory.
    function test_sendReplacesRetiredRoute() public {
        _queueDefault(_AMOUNT);
        _sucker.setRoute({routeState: JBSuckerState.SENDING_DISABLED, chainId: 1, remotePeer: bytes32(uint256(1))});
        bytes32 beforeState = _stateHash(_sucker);
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_SuckerNotSending.selector,
                address(_sucker),
                JBSuckerState.SENDING_DISABLED
            )
        );
        _sendDefault(_AMOUNT);
        assertEq(_stateHash(_sucker), beforeState);
        StickySourceSucker replacement = _newRoute(3);
        _mockPreview({
            route: replacement, projectId: 3, amount: _AMOUNT, backing: JBConstants.NATIVE_TOKEN, gross: _PREVIEW
        });
        _sendTo({
            projectId: 3,
            stickyToken: _stickyA,
            groupId: 0,
            amount: _AMOUNT,
            route: replacement,
            backing: JBConstants.NATIVE_TOKEN,
            value: _FEE
        });
        assertEq(_collector.totalPendingOf(3), 0);
        assertEq(_sucker.prepareCalls(), 0);
        assertEq(replacement.outboxOf(JBConstants.NATIVE_TOKEN).numberOfClaimsSent, 1);
    }

    /// @notice Every prepared call must append exactly one new leaf and actually include it in a sent root.
    function test_sendRequiresPreparedLeafInclusion() public {
        _queueDefault(_AMOUNT);
        _mockDefaultPreview(_AMOUNT);
        _sucker.setOutbox({backing: JBConstants.NATIVE_TOKEN, count: 7, sent: 3, balance: 1 ether, nonce: 4});
        _sucker.setPrepareBehavior({leavesAdded: 0, failPrepare: false});
        _expectDefaultAtomicRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_UnexpectedLeafCount.selector, uint256(8), uint256(7)
            )
        );
        _sucker.setPrepareBehavior({leavesAdded: 2, failPrepare: false});
        _expectDefaultAtomicRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_UnexpectedLeafCount.selector, uint256(8), uint256(9)
            )
        );
        _sucker.setPrepareBehavior({leavesAdded: 1, failPrepare: false});
        _sucker.setBehavior({
            failFee: false, failTransport: false, leaveUnsent: true, receipt: _RECEIPT, transportRefund: 0
        });
        _expectDefaultAtomicRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_UnsentLeaf.selector, uint256(7), uint256(7)
            )
        );
        _sucker.setBehavior({
            failFee: false, failTransport: false, leaveUnsent: false, receipt: _RECEIPT, transportRefund: 0
        });
        assertEq(_sendDefault(_AMOUNT), 7);
        assertEq(_sucker.outboxOf(JBConstants.NATIVE_TOKEN).numberOfClaimsSent, 8);
        assertEq(_sucker.outboxOf(JBConstants.NATIVE_TOKEN).nonce, 5);
    }

    /// @notice Token-pull and allowance-cleanup rejection unwind accepted inventory and the complete prior outbox.
    function test_sendRollsBackPrincipalPullAndApprovalCleanup() public {
        _queueDefault(_AMOUNT);
        _mockDefaultPreview(_AMOUNT);
        _sucker.setPrepareBehavior({leavesAdded: 1, failPrepare: true});
        _expectDefaultAtomicRevert(abi.encodeWithSelector(StickySourceSucker.StickySourceSucker_Rejected.selector));
        _sucker.setPrepareBehavior({leavesAdded: 1, failPrepare: false});
        vm.mockCallRevert({
            callee: address(_three),
            data: abi.encodeCall(IERC20.approve, (address(_sucker), uint256(0))),
            revertData: abi.encodeWithSelector(StickySourceSucker.StickySourceSucker_Rejected.selector)
        });
        _expectDefaultAtomicRevert(abi.encodeWithSelector(StickySourceSucker.StickySourceSucker_Rejected.selector));
    }

    /// @notice A failed transport restores callback allocations as well as the selected bucket and minted receipts.
    function test_sendRollsBackTransportAndCallbackAcceptance() public {
        _queueDefault(_AMOUNT);
        _mockDefaultPreview(_AMOUNT);
        JBSplitHookContext memory callback =
            _context({projectId: 77, stickyToken: _stickyB, groupId: 4000, amount: 7e18});
        _sucker.setCallback({
            target: address(_controller),
            data: abi.encodeCall(StickySourceController.distribute, (callback)),
            duringPrepare: false
        });
        _sucker.setBehavior({
            failFee: false, failTransport: true, leaveUnsent: false, receipt: _RECEIPT, transportRefund: 0
        });
        _expectDefaultAtomicRevert(abi.encodeWithSelector(StickySourceSucker.StickySourceSucker_Rejected.selector));
        assertEq(_collector.totalPendingOf(77), 0);
        assertEq(_seventySeven.totalSupply(), 0);
    }

    /// @notice Token count can be reminted remotely even when its freshly quoted backing is zero.
    function test_sendSupportsZeroBackingAndPendingDeprecation() public {
        _queueDefault(_AMOUNT);
        _sucker.setRoute({routeState: JBSuckerState.DEPRECATION_PENDING, chainId: 1, remotePeer: bytes32(uint256(1))});
        _mockPreview({route: _sucker, projectId: 3, amount: _AMOUNT, backing: JBConstants.NATIVE_TOKEN, gross: 0});
        _sendDefault(_AMOUNT);
        assertEq(_sucker.minimumPrepared(), 0);
        assertEq(_sucker.principalPrepared(), _AMOUNT);
        assertEq(_sucker.outboxOf(JBConstants.NATIVE_TOKEN).numberOfClaimsSent, 1);
        assertEq(_collector.totalPendingOf(3), 0);
    }

    /// @notice A non-Ethereum destination accepts only its exact registered peer, including when Ethereum sends.
    function test_sendUsesConfiguredDestinationWithoutEthereumFallback() public {
        _collector = _newCollector(8453);
        vm.chainId(1);
        _queueDefault(_AMOUNT);
        _mockDefaultPreview(_AMOUNT);

        // The default Ethereum route cannot redirect a Base-bound bucket, even though it is registered.
        _expectDefaultAtomicRevert(_invalidRouteError());
        _sucker.setRoute({routeState: JBSuckerState.ENABLED, chainId: 42_161, remotePeer: bytes32(uint256(1))});
        _expectDefaultAtomicRevert(_invalidRouteError());
        _sucker.setRoute({routeState: JBSuckerState.ENABLED, chainId: 8453, remotePeer: bytes32(uint256(1))});

        // Choosing the exact destination changes only transport; the split's fixed receiver remains the beneficiary.
        assertEq(_sendDefault(_AMOUNT), 0);
        address receiver = _factory.predictReceiverOf({stickyToken: _stickyA, groupId: 0});
        assertEq(_sucker.beneficiaryPrepared(), bytes32(uint256(uint160(receiver))));
        assertEq(_collector.totalPendingOf(3), 0);
        assertEq(_three.balanceOf(address(_collector)), 0);
        assertEq(_sucker.outboxOf(JBConstants.NATIVE_TOKEN).numberOfClaimsSent, 1);
    }

    /// @notice Delivery resolves the current terminal, registry fee and quote rather than caching setup-time values.
    function test_sendUsesCurrentTerminalFeeAndQuote() public {
        _queueDefault(_AMOUNT);
        _terminal = makeAddr("replacement primary cashout terminal");
        vm.etch({target: _terminal, newRuntimeBytecode: hex"00"});
        _mockTerminal({projectId: 3, backing: JBConstants.NATIVE_TOKEN, terminal: _terminal});
        _mockFee(_FEE + 11);
        _mockPreview({
            route: _sucker, projectId: 3, amount: _AMOUNT, backing: JBConstants.NATIVE_TOKEN, gross: 17 ether
        });
        _sendTo({
            projectId: 3,
            stickyToken: _stickyA,
            groupId: 0,
            amount: _AMOUNT,
            route: _sucker,
            backing: JBConstants.NATIVE_TOKEN,
            value: _FEE + 11
        });
        assertEq(_sucker.sendValue(), _FEE + 11);
        assertEq(_sucker.minimumPrepared(), 17 ether - JBFees.standardFeeAmountFrom(17 ether));
        assertEq(_collector.totalPendingOf(3), 0);
    }

    /// @notice Incoming token callbacks cannot settle partially measured custody.
    function test_settleDuringAcceptanceIsRejected() public {
        vm.chainId(1);
        _queueDefault(_AMOUNT);
        _three.setTransferCallback({
            target: address(_collector),
            data: abi.encodeCall(StickySourceCollector.settle, (3, _stickyA, 0, 1)),
            rejectOnFailure: false
        });
        _queueDefault(7e18);
        assertFalse(_three.callbackSucceeded());
        assertEq(
            _three.callbackReason(),
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_InboundTransfer.selector, address(_three), uint256(1)
            )
        );
        assertEq(_collector.totalPendingOf(3), _AMOUNT + 7e18);
        assertEq(_distributor.fundedOf({stickyToken: _stickyA, groupId: 0, token: IERC20(address(_three))}), 0);
    }

    /// @notice Destination rejection restores the bucket, receiver donations and undeployed clone state.
    function test_settleFailureRollsBackReceiverCreationAndTransfer() public {
        vm.chainId(1);
        _queueDefault(_AMOUNT);
        address receiver = _factory.predictReceiverOf({stickyToken: _stickyA, groupId: 0});
        _three.mint({account: receiver, amount: 9e18});
        _distributor.setRejectFunding(true);
        bytes32 beforeState = _stateHash(_sucker);
        vm.expectRevert(StickySourceDistributor.StickySourceDistributor_Rejected.selector);
        _collector.settle({sourceProjectId: 3, stickyToken: _stickyA, groupId: 0, amount: _AMOUNT});
        assertEq(_stateHash(_sucker), beforeState);
        assertEq(receiver.code.length, 0);
        assertEq(_factory.receiverOf({stickyToken: _stickyA, groupId: 0}), address(0));
        assertEq(_three.balanceOf(receiver), 9e18);
        _distributor.setRejectFunding(false);
        assertEq(
            _collector.settle({sourceProjectId: 3, stickyToken: _stickyA, groupId: 0, amount: _AMOUNT}), _AMOUNT + 9e18
        );
    }

    /// @notice Local settlement follows the configured home chain and preserves the existing reward-group encoding.
    function test_settleUsesConfiguredHomeChainAndGroup() public {
        _collector = _newCollector(8453);
        vm.chainId(8453);
        _queue({projectId: 3, stickyToken: _stickyA, groupId: 4000, amount: _AMOUNT});
        _queueDefault(30e18);
        address receiver = _factory.predictReceiverOf({stickyToken: _stickyA, groupId: 4000});
        _three.mint({account: receiver, amount: 9e18});

        // The receiver's existing inventory joins only the unchanged tenure-group bucket's delivery.
        assertEq(_collector.DESTINATION_CHAIN_ID(), 8453);
        vm.prank(_caller);
        assertEq(_collector.settle({sourceProjectId: 3, stickyToken: _stickyA, groupId: 4000, amount: 40e18}), 49e18);
        assertEq(_distributor.fundedOf({stickyToken: _stickyA, groupId: 4000, token: IERC20(address(_three))}), 49e18);
        assertEq(_distributor.fundedOf({stickyToken: _stickyA, groupId: 0, token: IERC20(address(_three))}), 0);
        assertEq(_collector.pendingOf({sourceProjectId: 3, stickyToken: _stickyA, groupId: 4000}), 60e18);
        assertEq(_collector.pendingOf({sourceProjectId: 3, stickyToken: _stickyA, groupId: 0}), 30e18);
        assertEq(_collector.totalPendingOf(3), 90e18);
        assertEq(_three.balanceOf(address(_collector)), 90e18);
        assertEq(_three.balanceOf(receiver), 0);

        // Neither remote sending from the home nor local settlement on Ethereum can bypass that binding.
        vm.expectRevert(
            abi.encodeWithSelector(StickySourceCollector.StickySourceCollector_SourceOnly.selector, uint256(8453))
        );
        _sendDefault(1);
        vm.chainId(1);
        vm.expectRevert(
            abi.encodeWithSelector(StickySourceCollector.StickySourceCollector_DestinationOnly.selector, uint256(1))
        );
        _collector.settle({sourceProjectId: 3, stickyToken: _stickyA, groupId: 4000, amount: 1});
        assertEq(_collector.totalPendingOf(3), 90e18);
        assertEq(_three.balanceOf(address(_collector)), 90e18);
    }

    /// @notice Local delivery funds the chosen receiver, including preexisting receiver arrivals, atomically.
    function test_settleUsesRealReceiverAndPreservesOtherBuckets() public {
        vm.chainId(1);
        _queueDefault(_AMOUNT);
        _queue({projectId: 3, stickyToken: _stickyB, groupId: 4000, amount: 30e18});
        address receiver = _factory.predictReceiverOf({stickyToken: _stickyA, groupId: 0});
        _three.mint({account: receiver, amount: 9e18});
        _three.mint({account: address(_collector), amount: 13e18});
        vm.prank(_caller);
        assertEq(_collector.settle({sourceProjectId: 3, stickyToken: _stickyA, groupId: 0, amount: 40e18}), 49e18);
        assertEq(_distributor.fundedOf({stickyToken: _stickyA, groupId: 0, token: IERC20(address(_three))}), 49e18);
        assertEq(_collector.pendingOf({sourceProjectId: 3, stickyToken: _stickyA, groupId: 0}), 60e18);
        assertEq(_collector.pendingOf({sourceProjectId: 3, stickyToken: _stickyB, groupId: 4000}), 30e18);
        assertEq(_three.balanceOf(address(_collector)), 103e18);
        assertEq(_three.balanceOf(receiver), 0);
        assertEq(_factory.receiverOf({stickyToken: _stickyA, groupId: 0}), receiver);
    }

    /// @notice A failed fee payment and transport overpayment return only this caller's fresh credits.
    function test_transportAndRegistryRefundsAreIsolated() public {
        _queueDefault(_AMOUNT);
        _mockDefaultPreview(_AMOUNT);
        address child = address(_collector.FEE_PAYER());
        _one.mint({account: child, amount: 7e18});
        vm.deal({account: child, newBalance: 3 ether});
        _sucker.setBehavior({
            failFee: true, failTransport: false, leaveUnsent: false, receipt: 0, transportRefund: 0.015 ether
        });
        uint256 beforeBalance = _caller.balance;
        _sendTo({
            projectId: 3,
            stickyToken: _stickyA,
            groupId: 0,
            amount: _AMOUNT,
            route: _sucker,
            backing: JBConstants.NATIVE_TOKEN,
            value: _FEE + 0.02 ether
        });
        assertEq(_caller.balance, beforeBalance - 0.005 ether);
        assertEq(_one.balanceOf(child), 7e18);
        assertEq(child.balance, 3 ether);
        assertEq(_sucker.retainedToRemoteFeeOf(child), 0);
        assertEq(_sucker.retainedTransportPaymentRefundOf(child), 0);
        assertEq(_sucker.claimedAccount(), child);
        assertEq(_sucker.claimedBeneficiary(), _caller);
        assertEq(_sucker.claimedTransportAccount(), child);
        assertEq(_sucker.claimedTransportBeneficiary(), _caller);
    }

    /// @notice Both failing and incomplete transport refunds restore custody and earlier outbox state.
    function test_transportRefundFailuresAreAtomic() public {
        _queueDefault(_AMOUNT);
        _mockDefaultPreview(_AMOUNT);
        _sucker.setBehavior({
            failFee: false, failTransport: false, leaveUnsent: false, receipt: _RECEIPT, transportRefund: 0.01 ether
        });
        _sucker.setRefundBehavior({failFeeRefund: false, failTransportRefund: true, residual: false});
        bytes32 beforeState = _stateHash(_sucker);
        vm.expectRevert(StickySourceSucker.StickySourceSucker_Rejected.selector);
        _sendTo({
            projectId: 3,
            stickyToken: _stickyA,
            groupId: 0,
            amount: _AMOUNT,
            route: _sucker,
            backing: JBConstants.NATIVE_TOKEN,
            value: _FEE + 0.01 ether
        });
        assertEq(_stateHash(_sucker), beforeState);
        _sucker.setRefundBehavior({failFeeRefund: false, failTransportRefund: false, residual: true});
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceFeePayer.StickySourceFeePayer_RetainedTransportPayment.selector,
                address(_sucker),
                uint256(1)
            )
        );
        _sendTo({
            projectId: 3,
            stickyToken: _stickyA,
            groupId: 0,
            amount: _AMOUNT,
            route: _sucker,
            backing: JBConstants.NATIVE_TOKEN,
            value: _FEE + 0.01 ether
        });
        assertEq(_stateHash(_sucker), beforeState);
    }

    /// @notice A zero registry fee needs no receipt ERC-20 and still refunds excess transport payment atomically.
    function test_zeroFeeWithoutFeeTokenCanSubmitAndRefundTransport() public {
        _queueDefault(_AMOUNT);
        _mockDefaultPreview(50e18);
        _mockFee(0);
        _tokens.setToken({projectId: 1, token: address(0)});
        address child = address(_collector.FEE_PAYER());
        vm.deal({account: child, newBalance: 3 ether});
        vm.deal({account: address(_collector), newBalance: 2 ether});
        _sucker.setBehavior({failFee: false, failTransport: false, leaveUnsent: false, receipt: 0, transportRefund: 0});
        uint256 beforeBalance = _caller.balance;
        _sendTo({
            projectId: 3,
            stickyToken: _stickyA,
            groupId: 0,
            amount: 50e18,
            route: _sucker,
            backing: JBConstants.NATIVE_TOKEN,
            value: 0
        });
        assertEq(_caller.balance, beforeBalance);
        _sucker.setBehavior({
            failFee: false, failTransport: false, leaveUnsent: false, receipt: 0, transportRefund: 0.015 ether
        });
        _sendTo({
            projectId: 3,
            stickyToken: _stickyA,
            groupId: 0,
            amount: 50e18,
            route: _sucker,
            backing: JBConstants.NATIVE_TOKEN,
            value: 0.02 ether
        });
        assertEq(_caller.balance, beforeBalance - 0.005 ether);
        assertEq(child.balance, 3 ether);
        assertEq(address(_collector).balance, 2 ether);
        assertEq(_sucker.retainedToRemoteFeeOf(child), 0);
        assertEq(_sucker.retainedTransportPaymentRefundOf(child), 0);
        assertEq(_collector.totalPendingOf(3), 0);
        assertEq(_sucker.outboxOf(JBConstants.NATIVE_TOKEN).numberOfClaimsSent, 2);
    }

    /// @notice Independently queued destinations retain their exact liabilities across partial sends and retries.
    /// @param seed Entropy for principal, donations, callback reserves and partial amounts.
    /// @param sameToken Whether principal and fee receipts use the same project token.
    function testFuzz_bucketConservationAcrossCallers(bytes32 seed, bool sameToken) public {
        uint256 projectId = sameToken ? 1 : 3;
        StickySourceToken token = sameToken ? _one : _three;
        StickySourceSucker route = sameToken ? _newRoute(1) : _sucker;
        address child = address(_collector.FEE_PAYER());
        address firstCaller = _caller;
        address secondCaller = makeAddr("second delivery caller");
        vm.deal({account: secondCaller, newBalance: 100 ether});
        vm.deal({account: address(_collector), newBalance: 2 ether});
        vm.deal({account: child, newBalance: 3 ether});
        uint256 expectedA;
        uint256 expectedB;
        uint256 donatedPrincipal;
        uint256 donatedFees;
        uint256 firstReceipts;
        uint256 secondReceipts;
        uint256 burnedPrincipal;
        uint256 issuedPrincipal;
        for (uint256 i; i < 3; i++) {
            uint256 entropy = uint256(keccak256(abi.encode(seed, i)));
            uint256 allocation = bound(entropy, 2, 1e24);
            uint256 reserve = bound(entropy >> 64, 1, 1e24);
            uint256 donation = bound(entropy >> 128, 1, 1e20);
            uint256 sent = bound(entropy >> 192, 1, allocation);
            _queue({projectId: projectId, stickyToken: _stickyA, groupId: 0, amount: allocation});
            expectedA += allocation;
            issuedPrincipal += allocation;
            token.mint({account: address(_collector), amount: donation});
            donatedPrincipal += donation;
            _one.mint({account: child, amount: donation});
            donatedFees += donation;
            JBSplitHookContext memory callback =
                _context({projectId: projectId, stickyToken: _stickyB, groupId: 4000, amount: reserve});
            route.setCallback({
                target: address(_controller),
                data: abi.encodeCall(StickySourceController.distribute, (callback)),
                duringPrepare: false
            });
            _mockPreview({
                route: route, projectId: projectId, amount: sent, backing: JBConstants.NATIVE_TOKEN, gross: _PREVIEW
            });
            _caller = i == 0 || (i == 2 && uint256(seed) % 2 == 0) ? firstCaller : secondCaller;
            route.setBehavior({
                failFee: i == 1, failTransport: true, leaveUnsent: false, receipt: _RECEIPT, transportRefund: 0
            });
            bytes32 beforeState = _stateHash(route);
            vm.expectRevert(StickySourceSucker.StickySourceSucker_Rejected.selector);
            _sendTo({
                projectId: projectId,
                stickyToken: _stickyA,
                groupId: 0,
                amount: sent,
                route: route,
                backing: JBConstants.NATIVE_TOKEN,
                value: _FEE
            });
            assertEq(_stateHash(route), beforeState);
            route.setBehavior({
                failFee: i == 1, failTransport: false, leaveUnsent: false, receipt: _RECEIPT, transportRefund: 0
            });
            uint256 nativeBefore = _caller.balance;
            assertEq(
                _sendTo({
                    projectId: projectId,
                    stickyToken: _stickyA,
                    groupId: 0,
                    amount: sent,
                    route: route,
                    backing: JBConstants.NATIVE_TOKEN,
                    value: _FEE
                }),
                i
            );
            expectedA -= sent;
            expectedB += reserve;
            issuedPrincipal += reserve;
            burnedPrincipal += sent;
            if (i != 1) {
                if (_caller == firstCaller) firstReceipts += _RECEIPT;
                else secondReceipts += _RECEIPT;
            }
            assertEq(_collector.pendingOf({sourceProjectId: projectId, stickyToken: _stickyA, groupId: 0}), expectedA);
            assertEq(
                _collector.pendingOf({sourceProjectId: projectId, stickyToken: _stickyB, groupId: 4000}), expectedB
            );
            assertEq(_collector.totalPendingOf(projectId), expectedA + expectedB);
            assertEq(token.balanceOf(address(_collector)), expectedA + expectedB + donatedPrincipal);
            assertEq(_one.balanceOf(child), donatedFees);
            assertEq(_one.balanceOf(firstCaller), firstReceipts);
            assertEq(_one.balanceOf(secondCaller), secondReceipts);
            uint256 feeInventory = donatedFees + firstReceipts + secondReceipts;
            assertEq(
                token.totalSupply(),
                issuedPrincipal + donatedPrincipal - burnedPrincipal + (sameToken ? feeInventory : 0)
            );
            if (!sameToken) assertEq(_one.totalSupply(), feeInventory);
            assertEq(_caller.balance, nativeBefore - (i == 1 ? 0 : _FEE));
            assertEq(address(_collector).balance, 2 ether);
            assertEq(child.balance, 3 ether);
            assertEq(token.allowance({owner: address(_collector), spender: address(route)}), 0);
            assertEq(route.retainedToRemoteFeeOf(child), 0);
            assertEq(route.outboxOf(JBConstants.NATIVE_TOKEN).tree.count, i + 1);
            assertEq(route.outboxOf(JBConstants.NATIVE_TOKEN).numberOfClaimsSent, i + 1);
            assertEq(_controller.burned(), 0);
            assertEq(_controller.rejectedCallbacks(), 0);
        }
        assertEq(route.prepareCalls(), 3);
    }

    /// @notice Mixed receipt, donation, callback and delivery sequences preserve independent bucket liabilities.
    /// @dev Each run stays on one chain. The first eight steps exercise every action; later steps permute them.
    /// Ghost balances change only from chosen inputs, never from the collector's reported accounting.
    /// @param seed Entropy for action order, projects, pools, groups, receipt form and amounts.
    /// @param home Whether this run settles locally or submits through source routes.
    function testFuzz_mixedCustodySequence(bytes32 seed, bool home) public {
        vm.chainId(home ? 1 : 10);
        uint256[12] memory pending;
        uint256[12] memory delivered;
        uint256[3] memory donations;
        StickySourceSucker[3] memory routes = [_newRoute(1), _sucker, _newRoute(77)];
        address firstCaller = _caller;
        address secondCaller = makeAddr("sequence delivery caller");
        vm.deal({account: secondCaller, newBalance: 100 ether});

        // Start every bucket with ample custody so each selected action is meaningful even at the fuzz boundaries.
        for (uint256 bucket; bucket < 12; bucket++) {
            _sequenceQueue({bucket: bucket, amount: 1e24, credits: bucket % 2 == 0});
            pending[bucket] = 1e24;
        }

        for (uint256 step; step < 24; step++) {
            uint256 entropy = uint256(keccak256(abi.encode(seed, step)));
            _caller = entropy % 2 == 0 ? firstCaller : secondCaller;
            uint256 action = step < 8 ? step : entropy % 8;
            uint256 bucket = (entropy >> 8) % 12;
            uint256 projectId = _sequenceProjectId(bucket / 4);
            uint256 amount = 1 + ((entropy >> 32) % 1e20);
            bool credits = (entropy >> 192) % 2 == 0;
            StickySourceToken token = StickySourceToken(address(_tokens.tokenOf(projectId)));

            if (action < 2) {
                _sequenceQueue({bucket: bucket, amount: amount, credits: action == 1});
                pending[bucket] += amount;
            } else if (action == 2) {
                // Plain donations add a custody floor but confer no bucket spending authority.
                if (credits) {
                    _tokens.seedCredit({holder: address(_collector), projectId: projectId, amount: amount});
                } else {
                    token.mint({account: address(_collector), amount: amount});
                }
                donations[bucket / 4] += amount;
            } else if (action == 3) {
                uint256 nestedBucket = (entropy >> 208) % 12;
                uint256 nestedAmount = 1 + amount / 3;
                _sequenceArmReceipt({token: token, bucket: nestedBucket, amount: nestedAmount, credits: credits});
                _sequenceQueue({bucket: bucket, amount: amount, credits: false});
                assertTrue(token.callbackSucceeded());
                pending[bucket] += amount;
                pending[nestedBucket] += nestedAmount;
            } else {
                bool rejected = action >= 6;
                uint256 nestedBucket = (entropy >> 208) % 12;
                uint256 nestedAmount = 1 + amount / 3;
                if (action == 5) {
                    // Incoming reserves during an outbound token pull must remain queued under their own key.
                    _sequenceArmReceipt({token: token, bucket: nestedBucket, amount: nestedAmount, credits: credits});
                }
                if (action == 7) amount = pending[bucket] + 1;
                _sequenceDeliver({
                    bucket: bucket,
                    amount: amount,
                    route: routes[bucket / 4],
                    home: home,
                    failure: action == 6 ? 1 : (action == 7 ? 2 : 0)
                });
                if (!rejected) {
                    pending[bucket] -= amount;
                    delivered[bucket] += amount;
                    if (action == 5) {
                        assertTrue(token.callbackSucceeded());
                        pending[nestedBucket] += nestedAmount;
                    }
                }
            }
            _assertSequenceCustody({
                pending: pending, delivered: delivered, donations: donations, routes: routes, home: home
            });
        }
        assertEq(_controller.rejectedCallbacks(), 0);
        assertEq(_controller.burned(), 0);
    }

    /// @notice Same-project nesting cannot double-book the inner allocation, including when buckets coincide.
    /// @param rawOuter The outer reserve allocation.
    /// @param rawInner The nested reserve allocation.
    /// @param sameDestination Whether both allocations reward the same holder pool.
    function testFuzz_nestedAcceptanceConserves(uint96 rawOuter, uint96 rawInner, bool sameDestination) public {
        uint256 outer = bound(rawOuter, 1, 1e24);
        uint256 inner = bound(rawInner, 1, 1e24);
        address nestedDestination = sameDestination ? _stickyA : _stickyB;
        JBSplitHookContext memory nested =
            _context({projectId: 3, stickyToken: nestedDestination, groupId: 0, amount: inner});
        _three.setTransferCallback({
            target: address(_controller),
            data: abi.encodeCall(StickySourceController.distribute, (nested)),
            rejectOnFailure: true
        });
        _queue({projectId: 3, stickyToken: _stickyA, groupId: 0, amount: outer});
        assertTrue(_three.callbackSucceeded());
        assertEq(_controller.acceptedCallbacks(), 2);
        assertEq(_controller.rejectedCallbacks(), 0);
        assertEq(_controller.burned(), 0);
        assertEq(
            _collector.pendingOf({sourceProjectId: 3, stickyToken: _stickyA, groupId: 0}),
            outer + (sameDestination ? inner : 0)
        );
        assertEq(
            _collector.pendingOf({sourceProjectId: 3, stickyToken: _stickyB, groupId: 0}), sameDestination ? 0 : inner
        );
        assertEq(_collector.totalPendingOf(3), outer + inner);
        assertEq(_three.balanceOf(address(_collector)), outer + inner);
        assertEq(_three.totalSupply(), outer + inner);
    }

    //*********************************************************************//
    // ---------------------- internal transactions ---------------------- //
    //*********************************************************************//

    /// @notice Establishes one project's mutable canonical controller and ERC-20 identity.
    /// @param projectId The source project.
    /// @param token The source token.
    function _bindProject(uint256 projectId, StickySourceToken token) internal {
        _tokens.setToken({projectId: projectId, token: address(token)});
        _tokens.setController({projectId: projectId, controller: address(_controller)});
        vm.mockCall({
            callee: _directory,
            data: abi.encodeCall(IJBDirectory.controllerOf, (projectId)),
            returnData: abi.encode(address(_controller))
        });
        _mockTerminal({projectId: projectId, backing: JBConstants.NATIVE_TOKEN, terminal: _terminal});
    }

    /// @notice Calls the collector directly with the authenticated controller identity.
    /// @param context The exact context whose guard is exercised.
    function _dispatch(JBSplitHookContext memory context) internal {
        vm.prank(address(_controller));
        _collector.processSplitWith(context);
    }

    /// @notice Verifies that the specified rejected delivery leaves all modeled economic state untouched.
    /// @param reason The exact expected failure, excluding unrelated downstream errors.
    function _expectDefaultAtomicRevert(bytes memory reason) internal {
        bytes32 beforeState = _stateHash(_sucker);
        vm.expectRevert(reason);
        _sendDefault(_AMOUNT);
        assertEq(_stateHash(_sucker), beforeState);
    }

    /// @notice Sets the exact ordinary source cashout quote.
    /// @param amount The project-token atoms being quoted.
    function _mockDefaultPreview(uint256 amount) internal {
        _mockPreview({route: _sucker, projectId: 3, amount: amount, backing: JBConstants.NATIVE_TOKEN, gross: _PREVIEW});
    }

    /// @notice Sets the registry fee observed independently by the child and sucker fixture.
    /// @param fee The caller's required fee in wei.
    function _mockFee(uint256 fee) internal {
        vm.mockCall({
            callee: _registry, data: abi.encodeCall(IJBSuckerRegistry.toRemoteFee, ()), returnData: abi.encode(fee)
        });
    }

    /// @notice Mocks only the actual sucker holder/beneficiary cashout context, including backing units.
    /// @param route The source sucker.
    /// @param projectId The source project.
    /// @param amount The source-token atoms to cash out.
    /// @param backing The mapped cashout asset.
    /// @param gross The quoted backing atoms before the maximum fee deduction.
    function _mockPreview(
        StickySourceSucker route,
        uint256 projectId,
        uint256 amount,
        address backing,
        uint256 gross
    )
        internal
    {
        JBRuleset memory ruleset;
        vm.mockCall({
            callee: _terminal,
            data: abi.encodeCall(
                IJBCashOutTerminal.previewCashOutFrom,
                (address(route), projectId, amount, backing, payable(address(route)), bytes(""))
            ),
            returnData: abi.encode(ruleset, gross, uint256(0), new JBCashOutHookSpecification[](0))
        });
    }

    /// @notice Configures the canonical current primary terminal for one backing asset.
    /// @param projectId The source project.
    /// @param backing The source backing asset.
    /// @param terminal The current terminal, or zero when unavailable.
    function _mockTerminal(uint256 projectId, address backing, address terminal) internal {
        vm.mockCall({
            callee: _directory,
            data: abi.encodeCall(IJBDirectory.primaryTerminalOf, (projectId, backing)),
            returnData: abi.encode(terminal)
        });
    }

    /// @notice Deploys one destination family with the same canonical custody and receiver dependencies.
    /// @param destinationChainId The home chain bound into this collector's immutable configuration.
    /// @return collector The newly deployed collector and its isolated fee child.
    function _newCollector(uint256 destinationChainId) internal returns (StickySourceCollector collector) {
        return new StickySourceCollector({
            registry: IJBSuckerRegistry(_registry),
            tokens: IJBTokens(address(_tokens)),
            receiverFactory: IStickyRewardReceiverFactory(address(_factory)),
            destinationChainId: destinationChainId
        });
    }

    /// @notice Deploys a real-state source fixture and registers its default native mapping.
    /// @param projectId The route's source project.
    /// @return route The newly configured source route.
    function _newRoute(uint256 projectId) internal returns (StickySourceSucker route) {
        route = new StickySourceSucker({
            registry: IJBSuckerRegistry(_registry),
            directory: IJBDirectory(_directory),
            tokens: _tokens,
            sourceProjectId: projectId
        });
        _registerRoute({route: route, projectId: projectId, registered: true});
        route.setMapping({
            backing: JBConstants.NATIVE_TOKEN,
            remoteToken: JBRemoteToken({
                enabled: true,
                emergencyHatch: false,
                minGas: 0,
                addr: bytes32(uint256(uint160(JBConstants.NATIVE_TOKEN)))
            })
        });
        route.setBehavior({
            failFee: false, failTransport: false, leaveUnsent: false, receipt: _RECEIPT, transportRefund: 0
        });
    }

    /// @notice Issues custody through the controller's actual allowance and caught-revert model.
    /// @param projectId The source project.
    /// @param stickyToken The home-chain holder pool.
    /// @param groupId Its reward group.
    /// @param amount The reserve allocation.
    function _queue(uint256 projectId, address stickyToken, uint256 groupId, uint256 amount) internal {
        _controller.distribute(
            _context({projectId: projectId, stickyToken: stickyToken, groupId: groupId, amount: amount})
        );
    }

    /// @notice Issues and distributes the ordinary project-3 allocation.
    /// @param amount The allocation in project-token atoms.
    function _queueDefault(uint256 amount) internal {
        _queue({projectId: 3, stickyToken: _stickyA, groupId: 0, amount: amount});
    }

    /// @notice Sets only this route's canonical registry membership.
    /// @param route The source route being admitted or rejected.
    /// @param projectId The canonical source project.
    /// @param registered Whether the registry admits that route.
    function _registerRoute(StickySourceSucker route, uint256 projectId, bool registered) internal {
        vm.mockCall({
            callee: _registry,
            data: abi.encodeCall(IJBSuckerRegistry.isSuckerOf, (projectId, address(route))),
            returnData: abi.encode(registered)
        });
    }

    /// @notice Delivers one ordinary project-3 amount from the unrelated caller.
    /// @param amount The attributed amount to deliver.
    /// @return index The prepared leaf index.
    function _sendDefault(uint256 amount) internal returns (uint256 index) {
        return _sendTo({
            projectId: 3,
            stickyToken: _stickyA,
            groupId: 0,
            amount: amount,
            route: _sucker,
            backing: JBConstants.NATIVE_TOKEN,
            value: _FEE
        });
    }

    /// @notice Delivers the exact selected bucket, route and value as the unrelated caller.
    /// @param projectId The source project.
    /// @param stickyToken The home-chain holder pool.
    /// @param groupId The reward group.
    /// @param amount The positive attributed amount.
    /// @param route The chosen registered route.
    /// @param backing The route's backing asset.
    /// @param value The supplied registry fee plus transport budget.
    /// @return index The prepared leaf index.
    function _sendTo(
        uint256 projectId,
        address stickyToken,
        uint256 groupId,
        uint256 amount,
        StickySourceSucker route,
        address backing,
        uint256 value
    )
        internal
        returns (uint256 index)
    {
        vm.prank(_caller);
        return _collector.send{value: value}({
            sourceProjectId: projectId,
            stickyToken: stickyToken,
            groupId: groupId,
            amount: amount,
            sucker: JBSucker(payable(address(route))),
            backingToken: backing
        });
    }

    /// @notice Arms an authenticated nested allocation in the next principal transfer.
    /// @param token The project token whose transfer invokes the nested allocation.
    /// @param bucket The destination bucket for the nested allocation.
    /// @param amount The nested allocation in project-token atoms.
    /// @param credits Whether the nested controller context transfers credits.
    function _sequenceArmReceipt(StickySourceToken token, uint256 bucket, uint256 amount, bool credits) internal {
        JBSplitHookContext memory context = _sequenceContext({bucket: bucket, amount: amount, credits: credits});
        token.setTransferCallback({
            target: address(_controller),
            data: abi.encodeCall(StickySourceController.distribute, (context)),
            rejectOnFailure: true
        });
    }

    /// @notice Attempts one local or remote delivery, proving rollback for the selected exact failure.
    /// @param bucket The bucket selected by independent sequence inputs.
    /// @param amount The requested project-token amount.
    /// @param route The project's source delivery route.
    /// @param home Whether this sequence uses home-chain settlement.
    /// @param failure Zero for success, one for downstream rejection, or two for an overdraw.
    function _sequenceDeliver(
        uint256 bucket,
        uint256 amount,
        StickySourceSucker route,
        bool home,
        uint256 failure
    )
        internal
    {
        JBSplitHookContext memory context = _sequenceContext({bucket: bucket, amount: amount, credits: false});
        if (home) {
            _distributor.setRejectFunding(failure == 1);
        } else {
            _mockPreview({
                route: route,
                projectId: context.projectId,
                amount: amount,
                backing: JBConstants.NATIVE_TOKEN,
                gross: _PREVIEW
            });
            route.setBehavior({
                failFee: false, failTransport: failure == 1, leaveUnsent: false, receipt: _RECEIPT, transportRefund: 0
            });
        }
        bytes32 beforeState = _stateHash(route);
        uint256 leavesBefore = route.outboxOf(JBConstants.NATIVE_TOKEN).tree.count;
        if (failure == 1) {
            vm.expectRevert(
                home
                    ? StickySourceDistributor.StickySourceDistributor_Rejected.selector
                    : StickySourceSucker.StickySourceSucker_Rejected.selector
            );
        } else if (failure == 2) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    StickySourceCollector.StickySourceCollector_InsufficientPending.selector,
                    context.projectId,
                    address(context.split.beneficiary),
                    uint256(context.split.projectId),
                    amount,
                    amount - 1
                )
            );
        }
        if (home) {
            vm.prank(_caller);
            _collector.settle({
                sourceProjectId: context.projectId,
                stickyToken: address(context.split.beneficiary),
                groupId: context.split.projectId,
                amount: amount
            });
        } else {
            uint256 index = _sendTo({
                projectId: context.projectId,
                stickyToken: address(context.split.beneficiary),
                groupId: context.split.projectId,
                amount: amount,
                route: route,
                backing: JBConstants.NATIVE_TOKEN,
                value: _FEE
            });
            if (failure == 0) {
                assertEq(index, leavesBefore);
                assertEq(route.outboxOf(JBConstants.NATIVE_TOKEN).numberOfClaimsSent, leavesBefore + 1);
                assertEq(route.principalPrepared(), amount);
                assertEq(
                    route.beneficiaryPrepared(),
                    bytes32(
                        uint256(
                            uint160(
                                _factory.predictReceiverOf({
                                    stickyToken: address(context.split.beneficiary), groupId: context.split.projectId
                                })
                            )
                        )
                    )
                );
            }
        }
        if (failure != 0) assertEq(_stateHash(route), beforeState);
        _distributor.setRejectFunding(false);
    }

    /// @notice Issues one sequence allocation through the controller's caught-callback path.
    /// @param bucket The chosen source project, holder pool and reward group.
    /// @param amount The allocation in project-token atoms.
    /// @param credits Whether the context represents pretransferred project credits.
    function _sequenceQueue(uint256 bucket, uint256 amount, bool credits) internal {
        _controller.distribute(_sequenceContext({bucket: bucket, amount: amount, credits: credits}));
    }

    //*********************************************************************//
    // ------------------------- internal views -------------------------- //
    //*********************************************************************//

    /// @notice Checks all buckets, donation floors, destination receipts and outgoing approvals after every action.
    /// @param pending Independently accumulated bucket liabilities.
    /// @param delivered Independently accumulated successful delivery amounts.
    /// @param donations Unattributed ERC-20 and credit custody per project.
    /// @param routes Each project's source delivery route.
    /// @param home Whether successful delivery funds the local distributor.
    function _assertSequenceCustody(
        uint256[12] memory pending,
        uint256[12] memory delivered,
        uint256[3] memory donations,
        StickySourceSucker[3] memory routes,
        bool home
    )
        internal
        view
    {
        for (uint256 project; project < 3; project++) {
            uint256 projectId = _sequenceProjectId(project);
            IERC20 token = IERC20(address(_tokens.tokenOf(projectId)));
            uint256 aggregate;
            for (uint256 offset; offset < 4; offset++) {
                uint256 bucket = project * 4 + offset;
                address stickyToken = offset < 2 ? _stickyA : _stickyB;
                uint256 groupId = offset % 2 == 0 ? 0 : 4000;
                assertEq(
                    _collector.pendingOf({sourceProjectId: projectId, stickyToken: stickyToken, groupId: groupId}),
                    pending[bucket]
                );
                assertEq(
                    _distributor.fundedOf({stickyToken: stickyToken, groupId: groupId, token: token}),
                    home ? delivered[bucket] : 0
                );
                aggregate += pending[bucket];
            }
            assertEq(_collector.totalPendingOf(projectId), aggregate);
            assertEq(
                _tokens.totalBalanceOf({holder: address(_collector), projectId: projectId}),
                aggregate + donations[project]
            );
            assertEq(token.allowance({owner: address(_collector), spender: address(routes[project])}), 0);
            address child = address(_collector.FEE_PAYER());
            assertEq(routes[project].retainedToRemoteFeeOf(child), 0);
            assertEq(routes[project].retainedTransportPaymentRefundOf(child), 0);
        }
    }

    /// @notice Builds the actual reserved-split encoding for one attributed destination.
    /// @param projectId The source project.
    /// @param stickyToken The destination holder pool.
    /// @param groupId The destination reward group.
    /// @param amount The source reserve allocation.
    /// @return context The authenticated controller's callback context.
    function _context(
        uint256 projectId,
        address stickyToken,
        uint256 groupId,
        uint256 amount
    )
        internal
        view
        returns (JBSplitHookContext memory context)
    {
        return JBSplitHookContext({
            token: address(_tokens.tokenOf(projectId)),
            amount: amount,
            decimals: 18,
            projectId: projectId,
            groupId: 1,
            split: JBSplit({
                percent: 1_000_000_000,
                projectId: SafeCast.toUint64(groupId),
                beneficiary: payable(stickyToken),
                preferAddToBalance: false,
                lockedUntil: 0,
                hook: IJBSplitHook(address(_collector))
            })
        });
    }

    /// @notice Encodes the complete rejected mapping configured by a route-guard test.
    /// @return reason The backing asset and all mapping fields rejected by the collector.
    function _invalidMappingError() internal view returns (bytes memory reason) {
        return abi.encodeWithSelector(
            StickySourceCollector.StickySourceCollector_InvalidMapping.selector,
            address(_sucker),
            JBConstants.NATIVE_TOKEN,
            _sucker.remoteTokenFor(JBConstants.NATIVE_TOKEN)
        );
    }

    /// @notice Encodes the canonical route-binding error expected for the ordinary project-3 route.
    /// @return reason The exact project and route rejected by the collector.
    function _invalidRouteError() internal view returns (bytes memory reason) {
        return abi.encodeWithSelector(
            StickySourceCollector.StickySourceCollector_InvalidRoute.selector, uint256(3), address(_sucker)
        );
    }

    /// @notice Encodes the ordinary delivery used by adversarial callbacks.
    /// @param amount The selected bucket amount.
    /// @return data The collector's exact send calldata.
    function _sendData(uint256 amount) internal view returns (bytes memory data) {
        return abi.encodeCall(
            StickySourceCollector.send,
            (3, _stickyA, 0, amount, JBSucker(payable(address(_sucker))), JBConstants.NATIVE_TOKEN)
        );
    }

    /// @notice Resolves a ghost bucket index into the controller's authenticated split encoding.
    /// @param bucket The index across three projects, two pools and two groups.
    /// @param amount The chosen allocation in project-token atoms.
    /// @param credits Whether to use the controller's cached credit-only token context.
    /// @return context The valid split encoding for the chosen bucket.
    function _sequenceContext(
        uint256 bucket,
        uint256 amount,
        bool credits
    )
        internal
        view
        returns (JBSplitHookContext memory context)
    {
        context = _context({
            projectId: _sequenceProjectId(bucket / 4),
            stickyToken: bucket % 4 < 2 ? _stickyA : _stickyB,
            groupId: bucket % 2 == 0 ? 0 : 4000,
            amount: amount
        });
        if (credits) context.token = address(0);
    }

    /// @notice Converts one of the three independent ghost project indices to its configured source project.
    /// @param index The zero-based project index.
    /// @return projectId The V6 fee, REV or generic project ID.
    function _sequenceProjectId(uint256 index) internal pure returns (uint256 projectId) {
        return index == 0 ? 1 : (index == 1 ? 3 : 77);
    }

    /// @notice Captures custody, supply, liabilities, allowances, refunds and the prior frontier for atomicity checks.
    /// @param route The source route whose mutable state must be restored.
    /// @return state A digest of the independently observable economic state.
    function _stateHash(StickySourceSucker route) internal view returns (bytes32 state) {
        address child = address(_collector.FEE_PAYER());
        bytes32 custody;
        uint256[3] memory projects = [uint256(1), uint256(3), uint256(77)];
        for (uint256 i; i < projects.length; i++) {
            uint256 projectId = projects[i];
            IERC20 token = IERC20(address(_tokens.tokenOf(projectId)));
            custody = keccak256(
                abi.encode(
                    custody,
                    _collector.pendingOf({sourceProjectId: projectId, stickyToken: _stickyA, groupId: 0}),
                    _collector.pendingOf({sourceProjectId: projectId, stickyToken: _stickyB, groupId: 4000}),
                    _collector.totalPendingOf(projectId),
                    _tokens.creditBalanceOf({holder: address(_collector), projectId: projectId}),
                    _tokens.totalBalanceOf({holder: address(_collector), projectId: projectId})
                )
            );
            if (address(token) != address(0)) {
                custody = keccak256(
                    abi.encode(
                        custody,
                        token.totalSupply(),
                        token.balanceOf(_caller),
                        token.balanceOf(child),
                        token.balanceOf(address(route)),
                        token.allowance({owner: address(_collector), spender: address(route)})
                    )
                );
            }
        }
        return keccak256(
            abi.encode(
                custody,
                _caller.balance,
                address(route).balance,
                address(_collector).balance,
                child.balance,
                route.outboxOf(JBConstants.NATIVE_TOKEN),
                route.retainedToRemoteFeeOf(child),
                route.retainedTransportPaymentRefundOf(child),
                route.prepareCalls(),
                _controller.acceptedCallbacks(),
                _controller.rejectedCallbacks(),
                _controller.burned()
            )
        );
    }
}

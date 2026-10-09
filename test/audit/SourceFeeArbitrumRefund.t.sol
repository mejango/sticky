// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IInbox} from "@arbitrum/nitro-contracts/src/bridge/IInbox.sol";
import {IInboxBase} from "@arbitrum/nitro-contracts/src/bridge/IInboxBase.sol";
import {AddressAliasHelper} from "@arbitrum/nitro-contracts/src/libraries/AddressAliasHelper.sol";
import {IJBDirectory} from "@bananapus/core-v6/src/interfaces/IJBDirectory.sol";
import {IJBTokens} from "@bananapus/core-v6/src/interfaces/IJBTokens.sol";
import {JBConstants} from "@bananapus/core-v6/src/libraries/JBConstants.sol";
import {JBArbitrumSuckerDeployer} from "@bananapus/suckers-v6/src/deployers/JBArbitrumSuckerDeployer.sol";
import {JBLayer} from "@bananapus/suckers-v6/src/enums/JBLayer.sol";
import {IArbGatewayRouter} from "@bananapus/suckers-v6/src/interfaces/IArbGatewayRouter.sol";
import {IArbL1GatewayRouter} from "@bananapus/suckers-v6/src/interfaces/IArbL1GatewayRouter.sol";
import {IJBSucker} from "@bananapus/suckers-v6/src/interfaces/IJBSucker.sol";
import {IJBSuckerRegistry} from "@bananapus/suckers-v6/src/interfaces/IJBSuckerRegistry.sol";
import {IL1ArbitrumGateway} from "@bananapus/suckers-v6/src/interfaces/IL1ArbitrumGateway.sol";
import {Test} from "forge-std/Test.sol";

import {StickySourceFeePayer} from "../../src/StickySourceFeePayer.sol";
import {SourceFeeArbitrumHarness} from "../helpers/SourceFeeArbitrumHarness.sol";
import {StickySourceToken} from "../helpers/StickySourceToken.sol";

/// @notice Captures the installed Arbitrum transport's asynchronous refund destination.
/// @dev This proves source calldata and child custody behavior; it does not model Arbitrum finality or ArbOS refunds.
contract SourceFeeArbitrumRefundTest is Test {
    /// @notice The source submission child whose address becomes the sucker caller.
    StickySourceFeePayer internal _child;

    /// @notice The mocked Inbox endpoint receiving the real transport's encoded request.
    address internal _inbox;

    /// @notice The mocked gateway router endpoint.
    address internal _router;

    /// @notice The installed sucker implementation with an exposed transport entrypoint.
    SourceFeeArbitrumHarness internal _sucker;

    /// @notice Configures endpoint reads while preserving the actual upstream transport implementation.
    function setUp() public {
        address deployer = makeAddr("Arbitrum deployer");
        address directory = makeAddr("directory");
        address tokens = makeAddr("tokens");
        address registry = makeAddr("registry");
        _inbox = makeAddr("Inbox");
        _router = makeAddr("gateway router");
        vm.mockCall(deployer, abi.encodeWithSignature("arbInbox()"), abi.encode(_inbox));
        vm.mockCall(deployer, abi.encodeWithSignature("arbGatewayRouter()"), abi.encode(_router));
        vm.mockCall(deployer, abi.encodeWithSignature("arbLayer()"), abi.encode(JBLayer.L1));
        vm.mockCall(directory, abi.encodeWithSignature("PROJECTS()"), abi.encode(makeAddr("projects")));
        vm.mockCall(registry, abi.encodeCall(IJBSuckerRegistry.toRemoteFee, ()), abi.encode(uint256(0)));
        vm.mockCall(tokens, abi.encodeCall(IJBTokens.tokenOf, (1)), abi.encode(address(0)));
        vm.mockCall(
            _inbox, abi.encodeWithSelector(IInboxBase.calculateRetryableSubmissionFee.selector), abi.encode(1 gwei)
        );
        vm.mockCall(_inbox, abi.encodeWithSelector(IInbox.unsafeCreateRetryableTicket.selector), abi.encode(uint256(1)));
        _sucker = new SourceFeeArbitrumHarness({
            deployer: JBArbitrumSuckerDeployer(deployer),
            directory: IJBDirectory(directory),
            tokens: IJBTokens(tokens),
            registry: IJBSuckerRegistry(registry)
        });
        _child = new StickySourceFeePayer();
        vm.fee(1 gwei);
        vm.deal(address(_child), 1 ether);
    }

    /// @notice The token-gateway request names the child before the safe Inbox aliases its final refund account.
    function test_erc20TransportAssignsGatewayRequestToChildBeforeAliasing() public {
        StickySourceToken token = new StickySourceToken();
        address gateway = makeAddr("gateway");
        vm.mockCall(_router, abi.encodeCall(IArbGatewayRouter.getGateway, (address(token))), abi.encode(gateway));
        vm.mockCall(
            gateway, abi.encodeWithSelector(IL1ArbitrumGateway.getOutboundCalldata.selector), abi.encode(hex"1234")
        );
        vm.mockCall(
            _router,
            abi.encodeWithSelector(IArbL1GatewayRouter.outboundTransferCustomRefund.selector),
            abi.encode(bytes(""))
        );

        // Equal gas budgets split this exact payment equally between the gateway and root tickets.
        vm.expectCall(
            _router,
            0.5 ether,
            abi.encodeCall(
                IArbL1GatewayRouter.outboundTransferCustomRefund,
                (address(token), address(_child), address(0xBEEF), 1, 200_000, 1 gwei, abi.encode(1 gwei, bytes("")))
            )
        );
        _expectRootTicket(0.5 ether);
        vm.prank(address(_child));
        _sucker.transport{value: 1 ether}({token: address(token), amount: 1});

        // Safe Inbox submission aliases an L1 contract recipient, unlike the root's unsafe retryable below.
        assertNotEq(AddressAliasHelper.applyL1ToL2Alias(address(_child)), address(_child));
    }

    /// @notice A later native balance at the child cannot subsidize or leave through its `send` entrypoint.
    function test_sendOnlyForwardsFreshValue() public {
        vm.deal(address(_child), 3 ether);
        vm.deal(address(this), 1 ether);
        bytes memory submission = abi.encodeCall(IJBSucker.toRemote, (JBConstants.NATIVE_TOKEN));
        vm.mockCall(address(_sucker), submission, bytes(""));
        vm.expectCall(address(_sucker), 1 ether, submission);
        _child.send{value: 1 ether}({
            sucker: IJBSucker(address(_sucker)),
            backingToken: JBConstants.NATIVE_TOKEN,
            beneficiary: payable(makeAddr("delivery caller"))
        });
        assertEq(address(_child).balance, 3 ether);
    }

    /// @notice Native retryable refunds target the fee child's unaliased address on Arbitrum.
    function test_nativeTransportAssignsRefundsToChild() public {
        _expectRootTicket(1 ether);
        vm.prank(address(_child));
        _sucker.transport{value: 1 ether}({token: JBConstants.NATIVE_TOKEN, amount: 0});
    }

    /// @notice Requires the exact upstream unsafe-Inbox call, including the child refund address.
    /// @param payment The native deposit supplied to the root retryable.
    function _expectRootTicket(uint256 payment) internal {
        vm.expectCall(
            _inbox,
            payment,
            abi.encodeCall(
                IInbox.unsafeCreateRetryableTicket,
                (address(0xBEEF), 0, 1 gwei, address(_child), address(0xBEEF), 200_000, 1 gwei, hex"1234")
            )
        );
    }
}

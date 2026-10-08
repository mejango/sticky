// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IJBCashOutTerminal} from "@bananapus/core-v6/src/interfaces/IJBCashOutTerminal.sol";
import {IJBDirectory} from "@bananapus/core-v6/src/interfaces/IJBDirectory.sol";
import {IJBTerminal} from "@bananapus/core-v6/src/interfaces/IJBTerminal.sol";
import {IJBTokens} from "@bananapus/core-v6/src/interfaces/IJBTokens.sol";
import {JBConstants} from "@bananapus/core-v6/src/libraries/JBConstants.sol";
import {JBFees} from "@bananapus/core-v6/src/libraries/JBFees.sol";
import {JBCashOutHookSpecification} from "@bananapus/core-v6/src/structs/JBCashOutHookSpecification.sol";
import {JBRuleset} from "@bananapus/core-v6/src/structs/JBRuleset.sol";
import {JBSucker} from "@bananapus/suckers-v6/src/JBSucker.sol";
import {JBSuckerState} from "@bananapus/suckers-v6/src/enums/JBSuckerState.sol";
import {IJBSucker} from "@bananapus/suckers-v6/src/interfaces/IJBSucker.sol";
import {IJBSuckerRegistry} from "@bananapus/suckers-v6/src/interfaces/IJBSuckerRegistry.sol";
import {JBOutboxTree} from "@bananapus/suckers-v6/src/structs/JBOutboxTree.sol";
import {JBRemoteToken} from "@bananapus/suckers-v6/src/structs/JBRemoteToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Test} from "forge-std/Test.sol";

import {StickySourceCollector} from "../src/StickySourceCollector.sol";
import {StickySourceFeePayer} from "../src/StickySourceFeePayer.sol";

import {StickyPricingToken} from "./helpers/StickyPricingToken.sol";

/// @notice A stateful source sucker double that transfers principal and models outbox and retained-fee changes.
/// @dev Read-only route identity is mocked separately; money and outbox mutations use real EVM state for rollback.
// The fixture stays beside its sole consumer.
// forge-lint: disable-next-line(multi-contract-file)
contract StickySourceSuckerStub {
    //*********************************************************************//
    // --------------------------- custom errors ------------------------- //
    //*********************************************************************//

    /// @notice Thrown when this scenario rejects transport or a refund.
    error StickySourceSuckerStub_Rejected();

    //*********************************************************************//
    // --------------- public immutable stored properties ---------------- //
    //*********************************************************************//

    /// @notice The token minted by a successful fee payment.
    StickyPricingToken public immutable FEE_TOKEN;

    /// @notice The source principal transferred during preparation.
    StickyPricingToken public immutable SOURCE_TOKEN;

    //*********************************************************************//
    // --------------------- public stored properties -------------------- //
    //*********************************************************************//

    /// @notice The source allowance observed before preparation spends it.
    uint256 public allowanceAtPrepare;

    /// @notice The allowance remaining when transport is submitted.
    uint256 public allowanceAtSend;

    /// @notice The receiver encoded in the prepared leaf.
    bytes32 public beneficiaryPrepared;

    /// @notice The account whose retained fee was last claimed.
    address public claimedAccount;

    /// @notice The recipient passed to the retained-fee claim.
    address public claimedBeneficiary;

    /// @notice The collector that most recently prepared a leaf.
    address public collector;

    /// @notice The attribution metadata encoded in the leaf.
    bytes32 public metadataPrepared;

    /// @notice The cashout minimum passed to prepare.
    uint256 public minimumPrepared;

    /// @notice The number of prepare calls completed.
    uint256 public prepareCalls;

    /// @notice The amount of principal pulled during the last prepare.
    uint256 public principalPrepared;

    /// @notice The number of nested collector calls attempted.
    uint256 public reentryAttempts;

    /// @notice The nested collector call's revert data.
    bytes public reentryReason;

    /// @notice Whether a nested collector call succeeded.
    bool public reentrySucceeded;

    /// @notice The retained fee credit owed to each caller.
    /// @custom:param account The account that initiated the fee payment.
    mapping(address account => uint256 amount) public retainedToRemoteFeeOf;

    /// @notice The account that submitted transport.
    address public sender;

    /// @notice The ETH attached to the transport submission.
    uint256 public sendValue;

    /// @notice The token selected for preparation.
    address public tokenPrepared;

    /// @notice The token selected for transport.
    address public tokenSent;

    //*********************************************************************//
    // -------------------- internal stored properties ------------------- //
    //*********************************************************************//

    /// @notice Whether the fee payment creates refundable credit instead of tokens.
    bool internal _failFee;

    /// @notice Whether a retained-fee claim reverts.
    bool internal _failRefund;

    /// @notice Whether transport reverts after fee-side effects.
    bool internal _failTransport;

    /// @notice Whether transport leaves the newest leaf unsent.
    bool internal _leaveUnsent;

    /// @notice The number of leaves added by each prepare.
    uint256 internal _leavesAdded = 1;

    /// @notice The native outbox tracked by the mock.
    JBOutboxTree internal _outbox;

    /// @notice Source principal delivered to the collector during fee payment.
    uint256 internal _principalDuringFee;

    /// @notice The fee receipt issued to the child payer.
    uint256 internal _receipt;

    /// @notice Whether preparation attempts to reenter the collector.
    bool internal _reenterPrepare;

    /// @notice Whether fee payment attempts to reenter the collector.
    bool internal _reenterSend;

    /// @notice Whether a refund incorrectly leaves one wei of retained credit.
    bool internal _residualRefund;

    //*********************************************************************//
    // -------------------------- constructor ---------------------------- //
    //*********************************************************************//

    /// @notice Binds the actual ERC-20 balances exercised by the stub.
    /// @param sourceToken The token pulled from the collector.
    /// @param feeToken The token issued for the caller's fee.
    constructor(StickyPricingToken sourceToken, StickyPricingToken feeToken) {
        SOURCE_TOKEN = sourceToken;
        FEE_TOKEN = feeToken;
    }

    //*********************************************************************//
    // ---------------------- external transactions ---------------------- //
    //*********************************************************************//

    /// @notice Pays the caller's retained credit to its specified beneficiary.
    /// @param beneficiary The account receiving the failed-fee refund.
    function claimRetainedToRemoteFee(address payable beneficiary) external {
        if (_failRefund) revert StickySourceSuckerStub_Rejected();
        uint256 amount = retainedToRemoteFeeOf[msg.sender];
        claimedAccount = msg.sender;
        claimedBeneficiary = beneficiary;
        // Clear before the callback, matching the canonical sucker's refund ordering.
        retainedToRemoteFeeOf[msg.sender] = _residualRefund ? 1 : 0;
        // A rejecting beneficiary must unwind the whole source transaction.
        // forge-lint: disable-next-line(low-level-calls,arbitrary-send-eth)
        (bool success,) = beneficiary.call{value: amount}("");
        if (!success) revert StickySourceSuckerStub_Rejected();
    }

    /// @notice Pulls real principal and appends the configured number of native leaves.
    /// @param projectTokenCount The amount of source principal to pull.
    /// @param beneficiary The destination receiver encoded in the leaf.
    /// @param minTokensReclaimed The native cashout floor.
    /// @param token The backing asset selected by the collector.
    /// @param metadata The attribution metadata committed to the leaf.
    function prepare(
        uint256 projectTokenCount,
        bytes32 beneficiary,
        uint256 minTokensReclaimed,
        address token,
        bytes32 metadata
    )
        external
    {
        collector = msg.sender;
        allowanceAtPrepare = SOURCE_TOKEN.allowance({owner: msg.sender, spender: address(this)});
        SafeERC20.safeTransferFrom({
            token: IERC20(address(SOURCE_TOKEN)), from: msg.sender, to: address(this), value: projectTokenCount
        });
        beneficiaryPrepared = beneficiary;
        metadataPrepared = metadata;
        minimumPrepared = minTokensReclaimed;
        principalPrepared = projectTokenCount;
        tokenPrepared = token;
        prepareCalls++;
        if (_reenterPrepare) _attemptReentry(0);
        // Mutate a frontier slot as well as its counters so rollback checks cover the complete outbox.
        _outbox.tree.branch[0] = keccak256(abi.encode(projectTokenCount, beneficiary, minTokensReclaimed, metadata));
        _outbox.tree.count += _leavesAdded;
        _outbox.balance += minTokensReclaimed;
    }

    /// @notice Seeds already prepared leaves and the count transported before this attempt.
    /// @param count The existing leaf count.
    /// @param sent The existing transported leaf count.
    /// @param balance The native backing already queued for transport.
    /// @param nonce The outbox's previous transport nonce.
    function setOutbox(uint256 count, uint192 sent, uint256 balance, uint64 nonce) external {
        _outbox.tree.count = count;
        _outbox.numberOfClaimsSent = sent;
        _outbox.balance = balance;
        _outbox.nonce = nonce;
        // A nonzero prior frontier must survive every reverted prepare and transport.
        _outbox.tree.branch[0] = keccak256(abi.encode(count, sent, balance, nonce));
    }

    /// @notice Selects malformed preparation and reentry behavior.
    /// @param leavesAdded The number of leaves to append per call.
    /// @param reenter Whether preparation attempts a nested send.
    function setPrepareBehavior(uint256 leavesAdded, bool reenter) external {
        _leavesAdded = leavesAdded;
        _reenterPrepare = reenter;
    }

    /// @notice Selects failed or incomplete refund behavior.
    /// @param fail Whether the claim reverts.
    /// @param residual Whether the claim leaves one wei of credit.
    function setRefundBehavior(bool fail, bool residual) external {
        _failRefund = fail;
        _residualRefund = residual;
    }

    /// @notice Seeds existing retained credit to test that another caller cannot consume it.
    /// @param account The account owning the seeded credit.
    /// @param amount The retained amount.
    function setRetainedFee(address account, uint256 amount) external {
        retainedToRemoteFeeOf[account] = amount;
    }

    /// @notice Selects fee, transport, and callback behavior for the next send.
    /// @param failFee Whether fee payment fails and retains ETH.
    /// @param failTransport Whether transport reverts after fee processing.
    /// @param leaveUnsent Whether transport omits the newest leaf.
    /// @param receipt The fee-token receipt issued to the child.
    /// @param principal The source principal delivered to the collector by a fee callback.
    /// @param reenter Whether fee payment attempts to reenter the collector.
    function setSendBehavior(
        bool failFee,
        bool failTransport,
        bool leaveUnsent,
        uint256 receipt,
        uint256 principal,
        bool reenter
    )
        external
    {
        _failFee = failFee;
        _failTransport = failTransport;
        _leaveUnsent = leaveUnsent;
        _receipt = receipt;
        _principalDuringFee = principal;
        _reenterSend = reenter;
    }

    /// @notice Models fee effects and transport completion in the same transaction.
    /// @param token The backing asset whose outbox is submitted.
    function toRemote(address token) external payable {
        sender = msg.sender;
        sendValue = msg.value;
        tokenSent = token;
        allowanceAtSend = SOURCE_TOKEN.allowance({owner: collector, spender: address(this)});
        // These are separate recipients even when source principal and the fee receipt use the same ERC-20.
        if (_principalDuringFee != 0) SOURCE_TOKEN.mint({account: collector, amount: _principalDuringFee});
        if (_failFee) retainedToRemoteFeeOf[msg.sender] += msg.value;
        else if (_receipt != 0) FEE_TOKEN.mint({account: msg.sender, amount: _receipt});
        if (_reenterSend) _attemptReentry(msg.value);
        if (_failTransport) revert StickySourceSuckerStub_Rejected();
        // An older root can be sent successfully without including the just-prepared leaf.
        _outbox.numberOfClaimsSent = SafeCast.toUint192(_outbox.tree.count - (_leaveUnsent ? 1 : 0));
        _outbox.balance = 0;
        _outbox.nonce++;
    }

    //*********************************************************************//
    // ----------------------- external views ---------------------------- //
    //*********************************************************************//

    /// @notice Returns the stateful native outbox.
    /// @param token The backing asset being queried.
    /// @return outbox The current tree and transported count.
    function outboxOf(address token) external view returns (JBOutboxTree memory outbox) {
        if (token != JBConstants.NATIVE_TOKEN) revert StickySourceSuckerStub_Rejected();
        return _outbox;
    }

    //*********************************************************************//
    // ---------------------- internal transactions ---------------------- //
    //*********************************************************************//

    /// @notice Records the exact result of a nested send without hiding the outer transaction's behavior.
    /// @param value The ETH forwarded by the callback.
    function _attemptReentry(uint256 value) internal {
        reentryAttempts++;
        try StickySourceCollector(collector).send{value: value}() returns (uint256) {
            reentrySucceeded = true;
        } catch (bytes memory reason) {
            reentryReason = reason;
        }
    }
}

/// @notice Calls the collector and can reject or reenter a failed-fee refund.
// The fixture stays beside its sole consumer.
// forge-lint: disable-next-line(multi-contract-file)
contract StickySourceCaller {
    /// @notice Thrown when this caller rejects its refund.
    error StickySourceCaller_RejectRefund();

    /// @notice The collector invoked by this caller.
    StickySourceCollector public immutable COLLECTOR;

    /// @notice Whether the refund callback refuses ETH.
    bool public rejectRefund;

    /// @notice Whether the refund callback attempts a nested source send.
    bool public reenter;

    /// @notice The revert data returned by a nested source send.
    bytes public reentryReason;

    /// @notice Whether the nested source send succeeded.
    bool public reentrySucceeded;

    /// @notice The total refunds accepted by the caller.
    uint256 public refunded;

    /// @notice Binds the one collector this caller exercises.
    /// @param collector The collector under test.
    constructor(StickySourceCollector collector) {
        COLLECTOR = collector;
    }

    /// @notice Accepts or rejects a refund and optionally attempts to reenter the source operation.
    receive() external payable {
        if (rejectRefund) revert StickySourceCaller_RejectRefund();
        refunded += msg.value;
        if (reenter) {
            // Disable before calling so a missing guard cannot create an unbounded recursive fixture.
            reenter = false;
            try COLLECTOR.send{value: msg.value}() returns (uint256) {
                reentrySucceeded = true;
            } catch (bytes memory reason) {
                reentryReason = reason;
            }
        }
    }

    /// @notice Selects the refund callback's behavior.
    /// @param reject Whether the callback rejects the refund.
    /// @param attemptReentry Whether the callback calls send again.
    function configure(bool reject, bool attemptReentry) external {
        rejectRefund = reject;
        reenter = attemptReentry;
    }

    /// @notice Sends the attached fee through the fixed collector.
    /// @return leafIndex The prepared leaf index returned by the collector.
    function send() external payable returns (uint256 leafIndex) {
        return COLLECTOR.send{value: msg.value}();
    }
}

/// @notice Permissionless source submission preserves principal, isolates fee receipts and rolls failures back.
// The stateful fixtures are private to this test file.
// forge-lint: disable-next-line(multi-contract-file)
contract StickySourceCollectorTest is Test {
    //*********************************************************************//
    // ------------------------ internal constants ----------------------- //
    //*********************************************************************//

    /// @notice The initial reserved principal held by the collector.
    uint256 internal constant _AMOUNT = 100e18;

    /// @notice The current registry fee attached to each source send.
    uint256 internal constant _FEE = 0.001 ether;

    /// @notice Native backing returned by the cashout preview.
    uint256 internal constant _PREVIEW = 2 ether;

    /// @notice The fee-token receipt produced by a successful fee payment.
    uint256 internal constant _RECEIPT = 5e18;

    /// @notice Additional reserved principal delivered during a fee callback.
    uint256 internal constant _RESERVED = 7e18;

    //*********************************************************************//
    // -------------------- internal stored properties ------------------- //
    //*********************************************************************//

    /// @notice The unrelated account that pays the source send fee.
    address internal _caller;

    /// @notice The source collector under test.
    StickySourceCollector internal _collector;

    /// @notice The directory resolving the source native terminal.
    address internal _directory;

    /// @notice The standard token issued as a fee receipt.
    StickyPricingToken internal _feeToken;

    /// @notice The source project being collected.
    uint256 internal _projectId;

    /// @notice The fixed receiver on Ethereum.
    address internal _receiver;

    /// @notice The registry authorizing the source sucker and quoting the fee.
    address internal _registry;

    /// @notice The standard token holding reserved source principal.
    StickyPricingToken internal _sourceToken;

    /// @notice The stateful native sucker double.
    StickySourceSuckerStub internal _sucker;

    /// @notice The source native terminal whose preview is queried.
    address internal _terminal;

    /// @notice The registry resolving source and fee ERC-20 identities.
    address internal _tokens;

    //*********************************************************************//
    // ----------------------- public transactions ----------------------- //
    //*********************************************************************//

    /// @notice Creates an Optimism project 3 route with distinct source and fee tokens.
    function setUp() public {
        _caller = makeAddr("source fee payer");
        _directory = makeAddr("source directory");
        _receiver = makeAddr("Ethereum reward receiver");
        _registry = makeAddr("source sucker registry");
        _terminal = makeAddr("source native terminal");
        _tokens = makeAddr("source tokens registry");
        vm.chainId(10);
        vm.deal({account: _caller, newBalance: 10 ether});
        _setUpProject(3);
    }

    /// @notice Repeated unrelated callers conserve principal and their own fees across donations, callbacks and
    /// retries.
    /// @param seed Entropy for positive bounded additions, donations, callback reserves, fees and receipts.
    /// @param sameToken Whether source rewards and caller fee receipts share project 1's ERC-20.
    function testFuzz_sendConservesAcrossCallerSequences(bytes32 seed, bool sameToken) public {
        if (sameToken) _setUpProject(1);
        address child = address(_collector.FEE_PAYER());
        address firstCaller = _caller;
        address secondCaller = makeAddr("second sequence caller");
        uint256 principalDelivered = _AMOUNT;
        uint256 childDonations;
        uint256 firstReceipts;
        uint256 secondReceipts;
        uint256 feesPaid;
        // Each sequence begins with an older unsent frontier and unrelated native donations.
        _sucker.setOutbox({count: 7, sent: 3, balance: 1 ether, nonce: 4});
        vm.deal({account: address(_collector), newBalance: 2 ether});
        vm.deal({account: child, newBalance: 3 ether});
        vm.deal({account: secondCaller, newBalance: 10 ether});

        // Every input includes successful fee payment, a refund, and a repeated caller selected by the seed.
        for (uint256 i; i < 3; i++) {
            uint256 entropy = uint256(keccak256(abi.encode(seed, i)));
            uint256 addition = bound(entropy, 1, 1e24);
            uint256 donation = bound(entropy >> 32, 1, 1e24);
            uint256 callbackReserve = bound(entropy >> 64, 1, 1e24);
            uint256 receipt = i == 1 ? 0 : bound(entropy >> 96, 1, 1e24);
            uint256 fee = bound(entropy >> 128, 1, 1 ether);
            uint256 gross = bound(entropy >> 192, 1, 100 ether);
            _sourceToken.mint({account: address(_collector), amount: addition});
            _feeToken.mint({account: child, amount: donation});
            principalDelivered += addition;
            childDonations += donation;
            uint256 principalBefore = _sourceToken.balanceOf(address(_collector));
            uint256 preparedBefore = _sourceToken.balanceOf(address(_sucker));
            _mockPreview({amount: principalBefore, gross: gross, terminal: _terminal});
            _mockFee(fee);
            _caller = i == 0 || (i == 2 && uint256(seed) % 2 == 0) ? firstCaller : secondCaller;
            uint256 callerNativeBefore = _caller.balance;
            _sucker.setSendBehavior({
                failFee: i == 1,
                failTransport: true,
                leaveUnsent: false,
                receipt: receipt,
                principal: callbackReserve,
                reenter: false
            });

            // Fail after receipt or retained-credit creation, proving prior successful sends survive intact.
            bytes32 beforeState = _stateHash();
            vm.prank(_caller);
            vm.expectRevert(StickySourceSuckerStub.StickySourceSuckerStub_Rejected.selector);
            _collector.send{value: fee}();
            assertEq(_stateHash(), beforeState);
            assertEq(_feeToken.balanceOf(firstCaller), firstReceipts);
            assertEq(_feeToken.balanceOf(secondCaller), secondReceipts);

            _sucker.setSendBehavior({
                failFee: i == 1,
                failTransport: false,
                leaveUnsent: false,
                receipt: receipt,
                principal: callbackReserve,
                reenter: false
            });
            vm.prank(_caller);
            uint256 index = _collector.send{value: fee}();
            principalDelivered += callbackReserve;
            if (_caller == firstCaller) firstReceipts += receipt;
            else secondReceipts += receipt;
            if (i != 1) feesPaid += fee;

            // Principal moves to the sucker; reserves arriving during fee payment remain for the next send.
            assertEq(_sourceToken.balanceOf(address(_sucker)), preparedBefore + principalBefore);
            assertEq(_sourceToken.balanceOf(address(_collector)), callbackReserve);
            assertEq(
                _sourceToken.balanceOf(address(_sucker)) + _sourceToken.balanceOf(address(_collector)),
                principalDelivered
            );
            assertEq(_feeToken.balanceOf(child), childDonations);
            assertEq(_feeToken.balanceOf(firstCaller), firstReceipts);
            assertEq(_feeToken.balanceOf(secondCaller), secondReceipts);
            uint256 feeInventory = childDonations + firstReceipts + secondReceipts;
            assertEq(_sourceToken.totalSupply(), principalDelivered + (sameToken ? feeInventory : 0));
            if (!sameToken) assertEq(_feeToken.totalSupply(), feeInventory);
            assertEq(_caller.balance, callerNativeBefore - (i == 1 ? 0 : fee));
            assertEq(address(_sucker).balance, feesPaid);
            assertEq(address(_collector).balance, 2 ether);
            assertEq(child.balance, 3 ether);
            assertEq(_sucker.retainedToRemoteFeeOf(child), 0);
            assertEq(_sourceToken.allowance({owner: address(_collector), spender: address(_sucker)}), 0);
            assertEq(_sucker.beneficiaryPrepared(), bytes32(uint256(uint160(_receiver))));
            assertEq(index, 7 + i);
            JBOutboxTree memory outbox = _sucker.outboxOf(JBConstants.NATIVE_TOKEN);
            assertEq(outbox.tree.count, 8 + i);
            assertEq(outbox.numberOfClaimsSent, 8 + i);
            assertEq(outbox.nonce, 5 + i);
            assertEq(outbox.balance, 0);
        }
        // A fuzz input cannot pass by exercising only revert paths.
        assertEq(_sucker.prepareCalls(), 3);
    }

    /// @notice A scheduled retirement remains usable while the sucker still accepts preparation and submission.
    function test_constructorAcceptsPendingDeprecation() public {
        vm.mockCall({
            callee: address(_sucker),
            data: abi.encodeCall(IJBSucker.state, ()),
            returnData: abi.encode(JBSuckerState.DEPRECATION_PENDING)
        });
        StickySourceCollector collector = _deploy();
        assertEq(address(collector.SUCKER()), address(_sucker));
        _sourceToken.mint({account: address(collector), amount: _AMOUNT});
        vm.prank(_caller);
        assertEq(collector.send{value: _FEE}(), 0);
        assertEq(_sourceToken.balanceOf(address(collector)), 0);
    }

    /// @notice Each supported source chain accepts the fixed Ethereum route.
    function test_constructorAcceptsSupportedChains() public {
        uint256[3] memory chains = [uint256(10), uint256(8453), uint256(42_161)];
        for (uint256 i; i < chains.length; i++) {
            vm.chainId(chains[i]);
            StickySourceCollector collector = _deploy();
            assertEq(collector.PROJECT_ID(), _projectId);
            assertEq(collector.RECEIVER(), _receiver);
            assertEq(address(collector.SOURCE_TOKEN()), address(_sourceToken));
            assertEq(address(collector.SUCKER()), address(_sucker));
        }
    }

    /// @notice The child is bound to its collector, fixed sucker and fee-token identity.
    function test_constructorBindsFeePayer() public view {
        assertEq(address(_collector.FEE_PAYER().COLLECTOR()), address(_collector));
        assertEq(address(_collector.FEE_PAYER().SUCKER()), address(_sucker));
        assertEq(address(_collector.FEE_PAYER().FEE_TOKEN()), address(_feeToken));
    }

    /// @notice Route identity requires deployed source and fee-token code, not merely nonzero addresses.
    function test_constructorRejectsCodeLessTokens() public {
        vm.mockCall({
            callee: _tokens, data: abi.encodeCall(IJBTokens.tokenOf, (_projectId)), returnData: abi.encode(_caller)
        });
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_InvalidTokens.selector, _caller, address(_feeToken)
            )
        );
        _deploy();
    }

    /// @notice A fully deprecated route cannot create a collector that has no way to send its balance.
    function test_constructorRejectsDeprecatedSucker() public {
        vm.mockCall({
            callee: address(_sucker),
            data: abi.encodeCall(IJBSucker.state, ()),
            returnData: abi.encode(JBSuckerState.DEPRECATED)
        });
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_SuckerNotSending.selector,
                address(_sucker),
                JBSuckerState.DEPRECATED
            )
        );
        _deploy();
    }

    /// @notice Missing source or fee ERC-20 identities reject deployment.
    function test_constructorRejectsMissingTokens() public {
        vm.mockCall({
            callee: _tokens, data: abi.encodeCall(IJBTokens.tokenOf, (_projectId)), returnData: abi.encode(address(0))
        });
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_InvalidTokens.selector, address(0), address(_feeToken)
            )
        );
        _deploy();
        vm.mockCall({
            callee: _tokens,
            data: abi.encodeCall(IJBTokens.tokenOf, (_projectId)),
            returnData: abi.encode(address(_sourceToken))
        });
        vm.mockCall({callee: _tokens, data: abi.encodeCall(IJBTokens.tokenOf, (1)), returnData: abi.encode(address(0))});
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_InvalidTokens.selector, address(_sourceToken), address(0)
            )
        );
        _deploy();
    }

    /// @notice Disabled, emergency, and non-native remote mappings reject deployment.
    function test_constructorRejectsNativeMapping() public {
        _mockMapping({
            enabled: false, emergency: false, remoteToken: bytes32(uint256(uint160(JBConstants.NATIVE_TOKEN)))
        });
        vm.expectRevert(_nativeRouteError());
        _deploy();
        _mockMapping({enabled: true, emergency: true, remoteToken: bytes32(uint256(uint160(JBConstants.NATIVE_TOKEN)))});
        vm.expectRevert(_nativeRouteError());
        _deploy();
        _mockMapping({enabled: true, emergency: false, remoteToken: bytes32(uint256(uint160(address(_sourceToken))))});
        vm.expectRevert(_nativeRouteError());
        _deploy();
    }

    /// @notice The source sucker must charge the fixed protocol fee project.
    function test_constructorRejectsOtherFeeProject() public {
        vm.mockCall({
            callee: address(_sucker),
            data: abi.encodeWithSignature("FEE_PROJECT_ID()"),
            returnData: abi.encode(uint256(3))
        });
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_InvalidProject.selector, address(_sucker), _projectId
            )
        );
        _deploy();
    }

    /// @notice A non-Ethereum peer rejects deployment.
    function test_constructorRejectsOtherPeerChain() public {
        vm.mockCall({
            callee: address(_sucker),
            data: abi.encodeCall(IJBSucker.peerChainId, ()),
            returnData: abi.encode(uint256(10))
        });
        vm.expectRevert(_nativeRouteError());
        _deploy();
    }

    /// @notice Only projects 1 and 3 can use this collector.
    function test_constructorRejectsOtherProject() public {
        vm.mockCall({
            callee: address(_sucker), data: abi.encodeCall(IJBSucker.projectId, ()), returnData: abi.encode(uint256(2))
        });
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_InvalidProject.selector, address(_sucker), uint256(2)
            )
        );
        _deploy();
    }

    /// @notice A sending-disabled route cannot create a collector that has no way to send its balance.
    function test_constructorRejectsSendingDisabledSucker() public {
        vm.mockCall({
            callee: address(_sucker),
            data: abi.encodeCall(IJBSucker.state, ()),
            returnData: abi.encode(JBSuckerState.SENDING_DISABLED)
        });
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_SuckerNotSending.selector,
                address(_sucker),
                JBSuckerState.SENDING_DISABLED
            )
        );
        _deploy();
    }

    /// @notice An unregistered sucker rejects deployment even if its other route getters agree.
    function test_constructorRejectsUnregisteredSucker() public {
        vm.mockCall({
            callee: _registry,
            data: abi.encodeCall(IJBSuckerRegistry.isSuckerOf, (_projectId, address(_sucker))),
            returnData: abi.encode(false)
        });
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_InvalidProject.selector, address(_sucker), _projectId
            )
        );
        _deploy();
    }

    /// @notice Ethereum and unrelated chains cannot deploy a source collector.
    function test_constructorRejectsUnsupportedChains() public {
        vm.chainId(1);
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_InvalidRoute.selector,
                uint256(1),
                address(_sucker),
                _receiver
            )
        );
        _deploy();
        vm.chainId(137);
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_InvalidRoute.selector,
                uint256(137),
                address(_sucker),
                _receiver
            )
        );
        _deploy();
    }

    /// @notice A missing peer or code-less source cannot establish a valid native route.
    function test_constructorRejectsZeroPeerOrCodeLessSucker() public {
        vm.mockCall({
            callee: address(_sucker), data: abi.encodeCall(IJBSucker.peer, ()), returnData: abi.encode(bytes32(0))
        });
        vm.expectRevert(_nativeRouteError());
        _deploy();
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_InvalidRoute.selector, uint256(10), _caller, _receiver
            )
        );
        new StickySourceCollector({sucker: JBSucker(payable(_caller)), receiver: _receiver});
    }

    /// @notice A zero destination cannot receive bridged principal.
    function test_constructorRejectsZeroReceiver() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_InvalidRoute.selector,
                uint256(10),
                address(_sucker),
                address(0)
            )
        );
        new StickySourceCollector({sucker: JBSucker(payable(address(_sucker))), receiver: address(0)});
    }

    /// @notice Only the fixed collector can invoke its fee payer.
    function test_feePayerRejectsOtherCallers() public {
        StickySourceFeePayer child = _collector.FEE_PAYER();
        vm.prank(_caller);
        vm.expectRevert(
            abi.encodeWithSelector(StickySourceFeePayer.StickySourceFeePayer_Unauthorized.selector, _caller)
        );
        child.send{value: _FEE}(payable(_caller));
        assertEq(_sucker.sender(), address(0));
        assertEq(_sourceToken.balanceOf(address(_collector)), _AMOUNT);
    }

    /// @notice Donated child tokens are excluded from each caller's newly issued fee receipt.
    function test_sendExcludesChildDonationsAcrossCallers() public {
        address child = address(_collector.FEE_PAYER());
        _feeToken.mint({account: child, amount: _RESERVED});
        _send();
        assertEq(_feeToken.balanceOf(_caller), _RECEIPT);
        assertEq(_feeToken.balanceOf(child), _RESERVED);

        address nextCaller = makeAddr("next source fee payer");
        vm.deal({account: nextCaller, newBalance: _FEE});
        _sourceToken.mint({account: address(_collector), amount: _AMOUNT});
        vm.prank(nextCaller);
        _collector.send{value: _FEE}();
        assertEq(_feeToken.balanceOf(nextCaller), _RECEIPT);
        assertEq(_feeToken.balanceOf(_caller), _RECEIPT);
        assertEq(_feeToken.balanceOf(child), _RESERVED);
    }

    /// @notice Forced ETH on either custody address is neither needed nor swept by an ordinary send.
    function test_sendIgnoresForcedEthDonations() public {
        address child = address(_collector.FEE_PAYER());
        vm.deal({account: address(_collector), newBalance: 2 ether});
        vm.deal({account: child, newBalance: 3 ether});
        uint256 callerBefore = _caller.balance;
        _send();
        assertEq(address(_collector).balance, 2 ether);
        assertEq(child.balance, 3 ether);
        assertEq(_caller.balance, callerBefore - _FEE);
        assertEq(_sucker.sendValue(), _FEE);
    }

    /// @notice A successful send includes existing leaves plus this send's fixed-beneficiary leaf.
    function test_sendIncludesNewLeafAfterPreexistingOutbox() public {
        _sucker.setOutbox({count: 7, sent: 3, balance: 1 ether, nonce: 4});
        vm.expectCall(address(_sourceToken), abi.encodeCall(IERC20.approve, (address(_sucker), uint256(0))));
        uint256 leafIndex = _send();
        assertEq(leafIndex, 7);
        JBOutboxTree memory outbox = _sucker.outboxOf(JBConstants.NATIVE_TOKEN);
        assertEq(outbox.tree.count, 8);
        assertEq(outbox.numberOfClaimsSent, 8);
        assertEq(outbox.balance, 0);
        assertEq(outbox.nonce, 5);
        assertEq(_sucker.allowanceAtPrepare(), _AMOUNT);
        assertEq(_sucker.allowanceAtSend(), 0);
        assertEq(_sourceToken.allowance({owner: address(_collector), spender: address(_sucker)}), 0);
        assertEq(_sucker.principalPrepared(), _AMOUNT);
        assertEq(_sucker.beneficiaryPrepared(), bytes32(uint256(uint160(_receiver))));
        assertEq(_sucker.metadataPrepared(), bytes32(0));
        assertEq(_sucker.tokenPrepared(), JBConstants.NATIVE_TOKEN);
        assertEq(_sucker.tokenSent(), JBConstants.NATIVE_TOKEN);
        assertEq(_sucker.minimumPrepared(), _PREVIEW - JBFees.standardFeeAmountFrom(_PREVIEW));
        assertEq(_sucker.sender(), address(_collector.FEE_PAYER()));
        assertEq(_sucker.sendValue(), _FEE);
        assertEq(_sourceToken.balanceOf(address(_collector)), 0);
        assertEq(_sourceToken.balanceOf(address(_sucker)), _AMOUNT);
        assertEq(_feeToken.balanceOf(_caller), _RECEIPT);
    }

    /// @notice Project 1 principal arriving during its own fee payment cannot become the caller's receipt.
    function test_sendIsolatesReservedPrincipalWithSameFeeToken() public {
        _setUpProject(1);
        _sucker.setSendBehavior({
            failFee: false,
            failTransport: false,
            leaveUnsent: false,
            receipt: _RECEIPT,
            principal: _RESERVED,
            reenter: false
        });
        _send();
        assertEq(_sourceToken.balanceOf(address(_collector)), _RESERVED);
        assertEq(_sourceToken.balanceOf(_caller), _RECEIPT);
        assertEq(_sourceToken.balanceOf(address(_collector.FEE_PAYER())), 0);
        assertEq(_sourceToken.balanceOf(address(_sucker)), _AMOUNT);
    }

    /// @notice Failed fee payment refunds the current caller and leaves no child credit.
    function test_sendRefundsOnlyNewRetainedFee() public {
        _configureFailedFee();
        // Another account's retained credit is neither rejected nor claimed by this fee payer.
        _sucker.setRetainedFee({account: _caller, amount: _RESERVED});
        uint256 balanceBefore = _caller.balance;
        _send();
        assertEq(_caller.balance, balanceBefore);
        assertEq(_sucker.claimedAccount(), address(_collector.FEE_PAYER()));
        assertEq(_sucker.claimedBeneficiary(), _caller);
        assertEq(_sucker.retainedToRemoteFeeOf(address(_collector.FEE_PAYER())), 0);
        assertEq(_sucker.retainedToRemoteFeeOf(_caller), _RESERVED);
        assertEq(_feeToken.balanceOf(_caller), 0);
        assertEq(_sucker.outboxOf(JBConstants.NATIVE_TOKEN).numberOfClaimsSent, 1);
    }

    /// @notice Zero source balance and a zero native preview cannot create an empty reward leaf.
    function test_sendRejectsEmptyOrZeroPreview() public {
        vm.prank(address(_collector));
        bool transferred = _sourceToken.transfer({to: _caller, value: _AMOUNT});
        assertTrue(transferred);
        vm.expectRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_EmptyBalance.selector, address(_sourceToken)
            )
        );
        _send();
        _sourceToken.mint({account: address(_collector), amount: _AMOUNT});
        _mockPreview({amount: _AMOUNT, gross: 0, terminal: _terminal});
        _expectAtomicRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_ZeroReclaim.selector, _AMOUNT, uint256(0)
            )
        );
    }

    /// @notice A send can neither underpay nor overpay the exact current registry fee.
    function test_sendRejectsIncorrectFee() public {
        vm.prank(_caller);
        vm.expectRevert(
            abi.encodeWithSelector(StickySourceCollector.StickySourceCollector_IncorrectFee.selector, _FEE - 1, _FEE)
        );
        _collector.send{value: _FEE - 1}();
        vm.prank(_caller);
        vm.expectRevert(
            abi.encodeWithSelector(StickySourceCollector.StickySourceCollector_IncorrectFee.selector, _FEE + 1, _FEE)
        );
        _collector.send{value: _FEE + 1}();
        assertEq(_sourceToken.balanceOf(address(_collector)), _AMOUNT);
        assertEq(_sucker.prepareCalls(), 0);
    }

    /// @notice Missing native terminal fails before any source principal leaves custody.
    function test_sendRejectsMissingTerminal() public {
        vm.mockCall({
            callee: _directory,
            data: abi.encodeCall(IJBDirectory.primaryTerminalOf, (_projectId, JBConstants.NATIVE_TOKEN)),
            returnData: abi.encode(address(0))
        });
        _expectAtomicRevert(
            abi.encodeWithSelector(StickySourceCollector.StickySourceCollector_NoTerminal.selector, _projectId)
        );
    }

    /// @notice Preexisting child credit is not attributed to the next unrelated fee payer.
    function test_sendRejectsPreexistingChildCredit() public {
        _sucker.setRetainedFee({account: address(_collector.FEE_PAYER()), amount: _FEE});
        _expectAtomicRevert(
            abi.encodeWithSelector(StickySourceFeePayer.StickySourceFeePayer_RetainedFee.selector, _FEE)
        );
        assertEq(_sucker.retainedToRemoteFeeOf(address(_collector.FEE_PAYER())), _FEE);
    }

    /// @notice Both prepare and fee callbacks hit the collector's reentrancy guard.
    function test_sendRejectsReentryDuringPrepareAndFeePayment() public {
        _sucker.setPrepareBehavior({leavesAdded: 1, reenter: true});
        _sucker.setSendBehavior({
            failFee: false,
            failTransport: false,
            leaveUnsent: false,
            receipt: _RECEIPT,
            principal: _RESERVED,
            reenter: true
        });
        _send();
        assertEq(_sucker.reentryAttempts(), 2);
        assertFalse(_sucker.reentrySucceeded());
        assertEq(_sucker.reentryReason(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
        assertEq(_sucker.prepareCalls(), 1);
        assertEq(_sourceToken.balanceOf(address(_collector)), _RESERVED);
    }

    /// @notice The caller cannot start another send while its failed-fee refund is being delivered.
    function test_sendRejectsReentryDuringRefund() public {
        _configureFailedFee();
        StickySourceCaller caller = new StickySourceCaller(_collector);
        caller.configure({reject: false, attemptReentry: true});
        vm.deal({account: address(this), newBalance: _FEE});
        caller.send{value: _FEE}();
        assertEq(caller.refunded(), _FEE);
        assertFalse(caller.reentrySucceeded());
        assertEq(caller.reentryReason(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
        assertEq(_sucker.prepareCalls(), 1);
    }

    /// @notice A mapping changed after construction is rejected before preparing another leaf.
    function test_sendRejectsRemappedNativeToken() public {
        _mockMapping({enabled: true, emergency: false, remoteToken: bytes32(uint256(uint160(address(_sourceToken))))});
        _expectAtomicRevert(_nativeRouteError());
    }

    /// @notice A route retired after construction rejects sending without changing balances or the prior outbox.
    function test_sendRejectsRetiredSuckerAtomically() public {
        _sucker.setOutbox({count: 7, sent: 3, balance: 1 ether, nonce: 4});
        vm.mockCall({
            callee: address(_sucker),
            data: abi.encodeCall(IJBSucker.state, ()),
            returnData: abi.encode(JBSuckerState.SENDING_DISABLED)
        });
        _expectAtomicRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_SuckerNotSending.selector,
                address(_sucker),
                JBSuckerState.SENDING_DISABLED
            )
        );
    }

    /// @notice The collector rejects either zero or multiple appended leaves and rolls the transfer back.
    function test_sendRequiresExactlyOnePreparedLeaf() public {
        _sucker.setPrepareBehavior({leavesAdded: 0, reenter: false});
        _expectAtomicRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_UnexpectedLeafCount.selector, uint256(1), uint256(0)
            )
        );
        _sucker.setPrepareBehavior({leavesAdded: 2, reenter: false});
        _expectAtomicRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_UnexpectedLeafCount.selector, uint256(1), uint256(2)
            )
        );
    }

    /// @notice A failed refund claim or nonzero residual credit unwinds the whole attempt.
    function test_sendRollsBackFailedOrIncompleteRefund() public {
        _configureFailedFee();
        _sucker.setOutbox({count: 7, sent: 3, balance: 1 ether, nonce: 4});
        _sucker.setRefundBehavior({fail: true, residual: false});
        _expectAtomicRevert(abi.encodeWithSelector(StickySourceSuckerStub.StickySourceSuckerStub_Rejected.selector));
        _sucker.setRefundBehavior({fail: false, residual: true});
        _expectAtomicRevert(
            abi.encodeWithSelector(StickySourceFeePayer.StickySourceFeePayer_RetainedFee.selector, uint256(1))
        );
        assertEq(_sucker.retainedToRemoteFeeOf(address(_collector.FEE_PAYER())), 0);
    }

    /// @notice A source-token rejection during preparation restores the granted approval and existing outbox.
    function test_sendRollsBackFailedPrincipalPull() public {
        _sucker.setOutbox({count: 7, sent: 3, balance: 1 ether, nonce: 4});
        vm.mockCallRevert({
            callee: address(_sourceToken),
            data: abi.encodeCall(IERC20.transferFrom, (address(_collector), address(_sucker), _AMOUNT)),
            revertData: abi.encodeWithSelector(StickySourceSuckerStub.StickySourceSuckerStub_Rejected.selector)
        });
        _expectAtomicRevert(abi.encodeWithSelector(StickySourceSuckerStub.StickySourceSuckerStub_Rejected.selector));
    }

    /// @notice A rejected allowance cleanup unwinds the completed prepare before transport can be submitted.
    function test_sendRollsBackRejectedAllowanceReset() public {
        _sucker.setOutbox({count: 7, sent: 3, balance: 1 ether, nonce: 4});
        vm.mockCallRevert({
            callee: address(_sourceToken),
            data: abi.encodeCall(IERC20.approve, (address(_sucker), uint256(0))),
            revertData: abi.encodeWithSelector(StickySourceSuckerStub.StickySourceSuckerStub_Rejected.selector)
        });
        _expectAtomicRevert(abi.encodeWithSelector(StickySourceSuckerStub.StickySourceSuckerStub_Rejected.selector));
    }

    /// @notice A rejected fee receipt transfer restores principal, callback reserves, fee tokens and the outbox.
    function test_sendRollsBackRejectedFeeTokenTransfer() public {
        _sucker.setOutbox({count: 7, sent: 3, balance: 1 ether, nonce: 4});
        _sucker.setSendBehavior({
            failFee: false,
            failTransport: false,
            leaveUnsent: false,
            receipt: _RECEIPT,
            principal: _RESERVED,
            reenter: false
        });
        vm.mockCallRevert({
            callee: address(_feeToken),
            data: abi.encodeCall(IERC20.transfer, (_caller, _RECEIPT)),
            revertData: abi.encodeWithSelector(StickySourceSuckerStub.StickySourceSuckerStub_Rejected.selector)
        });
        _expectAtomicRevert(abi.encodeWithSelector(StickySourceSuckerStub.StickySourceSuckerStub_Rejected.selector));
    }

    /// @notice A caller rejecting its refund cannot strand principal; another caller can retry.
    function test_sendRollsBackRejectingRefundAndAllowsRetry() public {
        _configureFailedFee();
        _sucker.setOutbox({count: 7, sent: 3, balance: 1 ether, nonce: 4});
        StickySourceCaller caller = new StickySourceCaller(_collector);
        caller.configure({reject: true, attemptReentry: false});
        vm.deal({account: address(this), newBalance: _FEE});
        bytes32 beforeState = _stateHash();
        vm.expectRevert(StickySourceSuckerStub.StickySourceSuckerStub_Rejected.selector);
        caller.send{value: _FEE}();
        assertEq(_stateHash(), beforeState);
        assertEq(caller.refunded(), 0);
        _send();
        assertEq(_sourceToken.balanceOf(address(_collector)), 0);
        assertEq(_sucker.outboxOf(JBConstants.NATIVE_TOKEN).numberOfClaimsSent, 8);
    }

    /// @notice A transport revert also unwinds its already-issued receipts and callback-delivered principal.
    function test_sendRollsBackTransportFailure() public {
        _sucker.setOutbox({count: 7, sent: 3, balance: 1 ether, nonce: 4});
        _sucker.setSendBehavior({
            failFee: false,
            failTransport: true,
            leaveUnsent: false,
            receipt: _RECEIPT,
            principal: _RESERVED,
            reenter: false
        });
        _expectAtomicRevert(abi.encodeWithSelector(StickySourceSuckerStub.StickySourceSuckerStub_Rejected.selector));
    }

    /// @notice Sending only an older root fails the inclusion postcondition and unwinds fee processing.
    function test_sendRollsBackUnsentPreparedLeaf() public {
        _sucker.setOutbox({count: 7, sent: 3, balance: 1 ether, nonce: 4});
        _sucker.setSendBehavior({
            failFee: false,
            failTransport: false,
            leaveUnsent: true,
            receipt: _RECEIPT,
            principal: _RESERVED,
            reenter: false
        });
        _expectAtomicRevert(
            abi.encodeWithSelector(
                StickySourceCollector.StickySourceCollector_UnsentLeaf.selector, uint256(7), uint256(7)
            )
        );
    }

    /// @notice Each send resolves the current terminal, fee and full balance instead of a constructor-time quote.
    function test_sendUsesFreshTerminalFeeAndPreview() public {
        address currentTerminal = makeAddr("replacement native terminal");
        uint256 amount = _AMOUNT + _RESERVED;
        uint256 gross = _PREVIEW + 1 ether;
        uint256 fee = _FEE + 1;
        _sourceToken.mint({account: address(_collector), amount: _RESERVED});
        vm.mockCall({
            callee: _directory,
            data: abi.encodeCall(IJBDirectory.primaryTerminalOf, (_projectId, JBConstants.NATIVE_TOKEN)),
            returnData: abi.encode(currentTerminal)
        });
        _mockFee(fee);
        _mockPreview({amount: amount, gross: gross, terminal: currentTerminal});
        vm.expectCall(currentTerminal, _previewData(amount));
        vm.prank(_caller);
        _collector.send{value: fee}();
        assertEq(_sucker.principalPrepared(), amount);
        assertEq(_sucker.minimumPrepared(), gross - JBFees.standardFeeAmountFrom(gross));
        assertEq(_sucker.sendValue(), fee);
    }

    /// @notice A one-wei positive cashout remains usable and is not rounded down to a zero minimum.
    function test_sendUsesPositiveDustFloor() public {
        _mockPreview({amount: _AMOUNT, gross: 1, terminal: _terminal});
        _send();
        assertEq(_sucker.minimumPrepared(), 1);
    }

    /// @notice A zero registry fee submits the outbox without charging the caller or claiming a refund.
    function test_sendWithZeroFee() public {
        _mockFee(0);
        _sucker.setSendBehavior({
            failFee: false, failTransport: false, leaveUnsent: false, receipt: 0, principal: 0, reenter: false
        });
        vm.prank(_caller);
        _collector.send();
        assertEq(_sucker.sendValue(), 0);
        assertEq(_sucker.claimedAccount(), address(0));
        assertEq(_sucker.outboxOf(JBConstants.NATIVE_TOKEN).numberOfClaimsSent, 1);
    }

    //*********************************************************************//
    // ---------------------- internal transactions ---------------------- //
    //*********************************************************************//

    /// @notice Configures a best-effort fee failure with successful transport.
    function _configureFailedFee() internal {
        _sucker.setSendBehavior({
            failFee: true, failTransport: false, leaveUnsent: false, receipt: 0, principal: 0, reenter: false
        });
    }

    /// @notice Deploys a collector against the currently configured route.
    /// @return collector The freshly deployed collector.
    function _deploy() internal returns (StickySourceCollector collector) {
        return new StickySourceCollector({sucker: JBSucker(payable(address(_sucker))), receiver: _receiver});
    }

    /// @notice Verifies a failed send restores balances, fee credits, allowances and the outbox.
    /// @param reason The exact expected failure, excluding unrelated fixture errors.
    function _expectAtomicRevert(bytes memory reason) internal {
        bytes32 beforeState = _stateHash();
        vm.expectRevert(reason);
        _send();
        assertEq(_stateHash(), beforeState);
    }

    /// @notice Configures the current registry fee without freezing it in the stateful mock.
    /// @param fee The required ETH payment.
    function _mockFee(uint256 fee) internal {
        vm.mockCall({
            callee: _registry, data: abi.encodeCall(IJBSuckerRegistry.toRemoteFee, ()), returnData: abi.encode(fee)
        });
    }

    /// @notice Configures the native mapping read during construction and before every send.
    /// @param enabled Whether the mapping accepts prepares.
    /// @param emergency Whether the emergency hatch has been opened.
    /// @param remoteToken The mapped Ethereum asset.
    function _mockMapping(bool enabled, bool emergency, bytes32 remoteToken) internal {
        vm.mockCall({
            callee: address(_sucker),
            data: abi.encodeCall(IJBSucker.remoteTokenFor, (JBConstants.NATIVE_TOKEN)),
            returnData: abi.encode(
                JBRemoteToken({enabled: enabled, emergencyHatch: emergency, minGas: 0, addr: remoteToken})
            )
        });
    }

    /// @notice Configures only the exact expected preview arguments, so mismatched payer context cannot pass.
    /// @param amount The collector's current full source balance.
    /// @param gross The quoted native backing before the standard fee bound.
    /// @param terminal The current primary native terminal.
    function _mockPreview(uint256 amount, uint256 gross, address terminal) internal {
        JBRuleset memory ruleset;
        vm.mockCall({
            callee: terminal,
            data: _previewData(amount),
            returnData: abi.encode(ruleset, gross, uint256(0), new JBCashOutHookSpecification[](0))
        });
    }

    /// @notice Sends from the unrelated fee payer using the ordinary registry fee.
    /// @return leafIndex The prepared leaf's outbox index.
    function _send() internal returns (uint256 leafIndex) {
        vm.prank(_caller);
        return _collector.send{value: _FEE}();
    }

    /// @notice Creates a fixed route and funds it with source principal.
    /// @param projectId The supported source project, also selecting whether its token equals the fee token.
    function _setUpProject(uint256 projectId) internal {
        _projectId = projectId;
        _sourceToken = new StickyPricingToken(18);
        _feeToken = projectId == 1 ? _sourceToken : new StickyPricingToken(18);
        _sucker = new StickySourceSuckerStub({sourceToken: _sourceToken, feeToken: _feeToken});
        vm.mockCall({
            callee: address(_sucker),
            data: abi.encodeCall(IJBSucker.state, ()),
            returnData: abi.encode(JBSuckerState.ENABLED)
        });
        vm.mockCall({
            callee: address(_sucker), data: abi.encodeWithSignature("DIRECTORY()"), returnData: abi.encode(_directory)
        });
        vm.mockCall({
            callee: address(_sucker), data: abi.encodeWithSignature("TOKENS()"), returnData: abi.encode(_tokens)
        });
        vm.mockCall({
            callee: address(_sucker), data: abi.encodeWithSignature("REGISTRY()"), returnData: abi.encode(_registry)
        });
        vm.mockCall({
            callee: address(_sucker),
            data: abi.encodeWithSignature("FEE_PROJECT_ID()"),
            returnData: abi.encode(uint256(1))
        });
        vm.mockCall({
            callee: address(_sucker), data: abi.encodeCall(IJBSucker.projectId, ()), returnData: abi.encode(projectId)
        });
        vm.mockCall({
            callee: address(_sucker),
            data: abi.encodeCall(IJBSucker.peerChainId, ()),
            returnData: abi.encode(uint256(1))
        });
        vm.mockCall({
            callee: address(_sucker),
            data: abi.encodeCall(IJBSucker.peer, ()),
            returnData: abi.encode(bytes32(uint256(uint160(makeAddr("Ethereum peer sucker")))))
        });
        vm.mockCall({
            callee: _registry,
            data: abi.encodeCall(IJBSuckerRegistry.isSuckerOf, (projectId, address(_sucker))),
            returnData: abi.encode(true)
        });
        vm.mockCall({
            callee: _tokens, data: abi.encodeCall(IJBTokens.tokenOf, (1)), returnData: abi.encode(address(_feeToken))
        });
        vm.mockCall({
            callee: _tokens,
            data: abi.encodeCall(IJBTokens.tokenOf, (projectId)),
            returnData: abi.encode(address(_sourceToken))
        });
        vm.mockCall({
            callee: _directory,
            data: abi.encodeCall(IJBDirectory.primaryTerminalOf, (projectId, JBConstants.NATIVE_TOKEN)),
            returnData: abi.encode(IJBTerminal(_terminal))
        });
        _mockMapping({
            enabled: true, emergency: false, remoteToken: bytes32(uint256(uint160(JBConstants.NATIVE_TOKEN)))
        });
        _mockFee(_FEE);
        _mockPreview({amount: _AMOUNT, gross: _PREVIEW, terminal: _terminal});
        _collector = _deploy();
        _sourceToken.mint({account: address(_collector), amount: _AMOUNT});
        _sucker.setSendBehavior({
            failFee: false, failTransport: false, leaveUnsent: false, receipt: _RECEIPT, principal: 0, reenter: false
        });
    }

    //*********************************************************************//
    // ------------------------- internal views -------------------------- //
    //*********************************************************************//

    /// @notice Encodes the complete configured route context expected in a rejected native binding.
    /// @return reason The error carrying the fixture's peer and remote-token mapping.
    function _nativeRouteError() internal view returns (bytes memory reason) {
        JBSucker sucker = JBSucker(payable(address(_sucker)));
        return abi.encodeWithSelector(
            StickySourceCollector.StickySourceCollector_InvalidNativeRoute.selector,
            address(_sucker),
            sucker.peerChainId(),
            sucker.peer(),
            sucker.remoteTokenFor(JBConstants.NATIVE_TOKEN)
        );
    }

    /// @notice Encodes the sucker's actual cashout context rather than the collector's token custody context.
    /// @param amount The amount of source tokens being cashed out.
    /// @return data The expected terminal preview calldata.
    function _previewData(uint256 amount) internal view returns (bytes memory data) {
        return abi.encodeCall(
            IJBCashOutTerminal.previewCashOutFrom,
            (address(_sucker), _projectId, amount, JBConstants.NATIVE_TOKEN, payable(address(_sucker)), bytes(""))
        );
    }

    /// @notice Hashes the money and outbox state that must remain unchanged after a failed attempt.
    /// @return state The combined state digest.
    function _stateHash() internal view returns (bytes32 state) {
        address child = address(_collector.FEE_PAYER());
        bytes32 balances = keccak256(
            abi.encode(
                _sourceToken.balanceOf(address(_collector)),
                _sourceToken.balanceOf(address(_sucker)),
                _sourceToken.totalSupply(),
                _feeToken.balanceOf(_caller),
                _feeToken.balanceOf(child),
                _feeToken.totalSupply(),
                _caller.balance,
                address(_sucker).balance,
                address(_collector).balance,
                child.balance
            )
        );
        return keccak256(
            abi.encode(
                balances,
                _sourceToken.allowance({owner: address(_collector), spender: address(_sucker)}),
                _sucker.outboxOf(JBConstants.NATIVE_TOKEN),
                _sucker.retainedToRemoteFeeOf(child),
                _sucker.prepareCalls()
            )
        );
    }
}

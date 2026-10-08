// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IBridge} from "@arbitrum/nitro-contracts/src/bridge/IBridge.sol";
import {IOutbox} from "@arbitrum/nitro-contracts/src/bridge/IOutbox.sol";
import {ArbSys} from "@arbitrum/nitro-contracts/src/precompiles/ArbSys.sol";
import {IRollupCore} from "@arbitrum/nitro-contracts/src/rollup/IRollupCore.sol";
import {JBArbitrumSucker} from "@bananapus/suckers-v6/src/JBArbitrumSucker.sol";
import {JBSucker} from "@bananapus/suckers-v6/src/JBSucker.sol";
import {JBLayer} from "@bananapus/suckers-v6/src/enums/JBLayer.sol";
import {Bytes} from "@openzeppelin/contracts/utils/Bytes.sol";
import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";

/// @notice Relays actual native Arbitrum sucker calls through the deployed Ethereum bridge on local forks.
/// @dev Models only the ArbSys return and the authenticated outbox's finalized L2 sender context. It does not
/// prove consensus inclusion, withdrawal finality, the outbox's spent-message protection, or relayer operation.
/// Source calls, destination authentication, bridge escrow transfers, and both suckers execute their real code.
/// Callers must not install unrelated mocks during capture or delivery: Foundry clears mocks as one scope.
abstract contract StickyJbxArbitrumTransport is Test {
    //*********************************************************************//
    // ----------------------------- structs ----------------------------- //
    //*********************************************************************//

    /// @notice The exact call submitted by a deployed sucker to the Arbitrum system precompile.
    /// @custom:member sender The real source caller recorded at the precompile boundary.
    /// @custom:member target The destination decoded from that caller's actual calldata.
    /// @custom:member value The native value recorded on the same call.
    /// @custom:member data The complete destination calldata, including the source accounting bundle.
    struct ArbitrumMessage {
        address sender;
        address target;
        uint256 value;
        bytes data;
    }

    //*********************************************************************//
    // ----------------------- internal constants ------------------------ //
    //*********************************************************************//

    /// @notice The ArbSys precompile that accepts native L2-to-L1 messages.
    address internal constant _ARBITRUM_TRANSPORT_ARBSYS = address(100);

    /// @notice The EVM instruction that carries the native value and complete precompile calldata.
    uint8 internal constant _ARBITRUM_TRANSPORT_CALL_OPCODE = 0xf1;

    /// @notice CALL consumes gas, target, value, input offset/size and output offset/size.
    uint256 internal constant _ARBITRUM_TRANSPORT_CALL_OPERANDS = 7;

    /// @notice The only source chain supported by this native withdrawal fixture.
    uint256 internal constant _ARBITRUM_TRANSPORT_SOURCE_CHAIN_ID = 42_161;

    /// @notice The only destination chain supported by this native withdrawal fixture.
    uint256 internal constant _ARBITRUM_TRANSPORT_DESTINATION_CHAIN_ID = 1;

    //*********************************************************************//
    // --------------------- private stored properties ------------------- //
    //*********************************************************************//

    /// @notice The actual ArbSys native balance initialized before the captured withdrawal.
    uint256 private _arbitrumCaptureEscrowBefore;

    /// @notice The fork initialized at capture start and checked before consuming its opcode trace.
    uint256 private _arbitrumCaptureForkId;

    //*********************************************************************//
    // ---------------------- internal transactions ---------------------- //
    //*********************************************************************//

    /// @notice Executes a captured withdrawal using the real bridge and its current allowed outbox.
    /// @dev The normal sender is `message.sender`; a different context lets tests prove destination rejection.
    /// Native value comes only from the deployed bridge's existing escrow, never from a fabricated balance.
    /// @param message The unmodified source call returned by `_finishArbitrumMessageCapture`.
    /// @param remoteSender The finalized sender context presented by the outbox.
    /// @return success Whether the real destination sucker accepted the bridge call.
    /// @return returnData The actual destination call's return or revert data.
    function _deliverArbitrumMessage(
        ArbitrumMessage memory message,
        address remoteSender
    )
        internal
        returns (bool success, bytes memory returnData)
    {
        JBArbitrumSucker destination = JBArbitrumSucker(payable(message.target));
        (IBridge bridge, address outbox) = _arbitrumBridge(destination);
        assertEq(destination.peer(), bytes32(uint256(uint160(message.sender))), "captured source must be the peer");
        // Only the first four calldata bytes identify the function; the complete payload remains unchanged.
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(bytes4(message.data), JBSucker.fromRemote.selector, "native root delivery only");

        uint256 escrowBefore = address(bridge).balance;
        uint256 destinationBefore = message.target.balance;
        assertGe(escrowBefore, message.value, "deployed bridge escrow must cover captured value");
        assertEq(bridge.activeOutbox(), address(0), "bridge must start outside a withdrawal");

        // The bridge supplies msg.sender and activeOutbox itself; only the consensus-established sender is modeled.
        vm.mockCall({
            callee: outbox,
            data: abi.encodeCall(IOutbox.l2ToL1Sender, ()),
            returnData: abi.encode(remoteSender),
            injectCode: false
        });
        vm.prank(outbox);
        (success, returnData) = bridge.executeCall({to: message.target, value: message.value, data: message.data});
        vm.clearMockedCalls();

        // A rejected peer must retain the complete escrow; accepted fromRemote calls retain ETH in the sucker.
        uint256 delivered = success ? message.value : 0;
        assertEq(address(bridge).balance, escrowBefore - delivered, "exact native escrow debit");
        assertEq(message.target.balance, destinationBefore + delivered, "exact native sucker credit");
        assertEq(bridge.activeOutbox(), address(0), "bridge restores its authenticated call context");
    }

    /// @notice Extracts the sole native-root message actually called by the source sucker.
    /// @dev Invoke immediately after the parent's successful real `toRemote` call. Source event recording remains
    /// untouched. Opcode operands preserve mocked calls that Foundry excludes from its account-access recording.
    /// @param source The deployed Arbitrum sucker whose prepared outbox was sent.
    /// @return message The captured caller, destination, native value and complete destination calldata.
    function _finishArbitrumMessageCapture(JBArbitrumSucker source) internal returns (ArbitrumMessage memory message) {
        VmSafe.DebugStep[] memory steps = vm.stopAndReturnDebugTraceRecording();
        vm.clearMockedCalls();
        assertEq(block.chainid, _ARBITRUM_TRANSPORT_SOURCE_CHAIN_ID, "capture must finish on Arbitrum");
        assertEq(vm.activeFork(), _arbitrumCaptureForkId, "capture must finish on its original fork");
        assertEq(uint256(source.LAYER()), uint256(JBLayer.L2), "source sucker must be on L2");
        assertEq(source.peerChainId(), _ARBITRUM_TRANSPORT_DESTINATION_CHAIN_ID, "source peer must be Ethereum");

        // The peer is fixed throughout this read of the completed source execution.
        bytes32 sourcePeer = source.peer();
        uint256 count = 0;
        for (uint256 i = 0; i < steps.length; ++i) {
            VmSafe.DebugStep memory step = steps[i];
            if (step.opcode != _ARBITRUM_TRANSPORT_CALL_OPCODE) continue;
            assertEq(step.stack.length, _ARBITRUM_TRANSPORT_CALL_OPERANDS, "complete CALL operand capture");
            if (step.stack[1] != uint256(uint160(_ARBITRUM_TRANSPORT_ARBSYS))) continue;

            // CALL's top-first operands bind target, native value and input size to the exact memory read.
            assertEq(step.contractAddr, address(source), "actual precompile caller must be the source sucker");
            assertFalse(step.isOutOfGas, "captured native withdrawal must not exhaust gas");
            assertEq(step.memoryInput.length, step.stack[4], "complete CALL input capture");
            // Deliberately isolate the selector; the full precompile calldata is checked below.
            // forge-lint: disable-next-line(unsafe-typecast)
            assertEq(bytes4(step.memoryInput), ArbSys.sendTxToL1.selector, "capture only sendTxToL1");
            (message.target, message.data) =
                abi.decode(Bytes.slice({buffer: step.memoryInput, start: 4}), (address, bytes));
            message.sender = step.contractAddr;
            message.value = step.stack[2];

            // Preserve the entire emitted ABI, including its accounting bundle, without rebuilding remote state.
            assertEq(
                step.memoryInput, abi.encodeCall(ArbSys.sendTxToL1, (message.target, message.data)), "exact source ABI"
            );
            assertEq(bytes32(uint256(uint160(message.target))), sourcePeer, "captured destination must be the peer");
            // Deliberately isolate the destination selector without truncating the captured message.
            // forge-lint: disable-next-line(unsafe-typecast)
            assertEq(bytes4(message.data), JBSucker.fromRemote.selector, "capture only native root messages");
            ++count;
        }
        assertEq(count, 1, "exactly one actual ArbSys withdrawal must be captured");
        assertEq(
            _ARBITRUM_TRANSPORT_ARBSYS.balance,
            _arbitrumCaptureEscrowBefore + message.value,
            "exact native ArbSys transport credit"
        );
    }

    /// @notice Begins recording the real source call while supplying the unsupported ArbSys return value.
    /// @dev Requires Foundry's four-argument mockCall overload with `injectCode: false`; ordinary overloads may
    /// inject code at an empty address. Run Forge with `-vvv` or higher to create the required tracer. No code,
    /// token supply, reward inventory or backing balance is replaced.
    function _startArbitrumMessageCapture() internal {
        assertEq(block.chainid, _ARBITRUM_TRANSPORT_SOURCE_CHAIN_ID, "capture must start on Arbitrum");
        _arbitrumCaptureEscrowBefore = _ARBITRUM_TRANSPORT_ARBSYS.balance;
        _arbitrumCaptureForkId = vm.activeFork();
        vm.mockCall({
            callee: _ARBITRUM_TRANSPORT_ARBSYS,
            data: abi.encodePacked(ArbSys.sendTxToL1.selector),
            returnData: abi.encode(uint256(0)),
            injectCode: false
        });
        vm.startDebugTraceRecording();
    }

    //*********************************************************************//
    // ------------------------- internal views -------------------------- //
    //*********************************************************************//

    /// @notice Resolves and authenticates the destination's deployed bridge and the rollup's current outbox.
    /// @param destination The deployed Ethereum sucker that receives the captured source root.
    /// @return bridge The real native escrow bridge identified by the sucker's configured inbox.
    /// @return outbox The rollup's current outbox, bound to and allowed by that same bridge.
    function _arbitrumBridge(JBArbitrumSucker destination) internal view returns (IBridge bridge, address outbox) {
        assertEq(block.chainid, _ARBITRUM_TRANSPORT_DESTINATION_CHAIN_ID, "delivery must be on Ethereum");
        assertGt(address(destination).code.length, 0, "destination sucker must be deployed");
        assertEq(uint256(destination.LAYER()), uint256(JBLayer.L1), "destination sucker must be on L1");
        assertEq(destination.peerChainId(), _ARBITRUM_TRANSPORT_SOURCE_CHAIN_ID, "destination peer must be Arbitrum");
        bridge = IBridge(address(destination.ARBINBOX().bridge()));
        assertGt(address(bridge).code.length, 0, "native escrow bridge must be deployed");

        // The rollup identifies its current outbox; the bridge's historical allowlist alone cannot choose it.
        IRollupCore rollup = IRollupCore(address(bridge.rollup()));
        outbox = address(rollup.outbox());
        assertGt(outbox.code.length, 0, "current rollup outbox must be deployed");
        assertEq(address(rollup.bridge()), address(bridge), "rollup bridge binding");
        assertEq(address(IOutbox(outbox).bridge()), address(bridge), "outbox bridge binding");
        assertTrue(bridge.allowedOutboxes(outbox), "current rollup outbox must be authorized");
    }
}

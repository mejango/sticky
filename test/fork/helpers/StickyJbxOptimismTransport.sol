// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {JBConstants} from "@bananapus/core-v6/src/libraries/JBConstants.sol";
import {JBOptimismSucker} from "@bananapus/suckers-v6/src/JBOptimismSucker.sol";
import {JBSucker} from "@bananapus/suckers-v6/src/JBSucker.sol";
import {JBMessageRoot} from "@bananapus/suckers-v6/src/structs/JBMessageRoot.sol";
import {Bytes} from "@openzeppelin/contracts/utils/Bytes.sol";
import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

/// @notice The deployed Bedrock messenger's native withdrawal and receipt surface.
// forge-lint: disable-next-line(multi-contract-file)
interface IStickyJbxOpMessenger {
    function PORTAL() external view returns (address portal);
    function OTHER_MESSENGER() external view returns (address messenger);
    function successfulMessages(bytes32 messageHash) external view returns (bool success);
    function failedMessages(bytes32 messageHash) external view returns (bool failed);
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

/// @notice The finalized withdrawal context queried by the real L1 messenger.
// forge-lint: disable-next-line(multi-contract-file)
interface IStickyJbxOpPortal {
    function l2Sender() external view returns (address sender);
    function ethLockbox() external view returns (address lockbox);
    function systemConfig() external view returns (address config);
}

/// @notice The live Portal feature configuration used by production finalization.
// forge-lint: disable-next-line(multi-contract-file)
interface IStickyJbxOpSystemConfig {
    function isFeatureEnabled(bytes32 feature) external view returns (bool enabled);
}

/// @notice The deployed native escrow used by lockbox-enabled Portals when finalizing a withdrawal.
// forge-lint: disable-next-line(multi-contract-file)
interface IStickyJbxOpLockbox {
    function authorizedPortals(address portal) external view returns (bool authorized);
    // The deployed ABI spells the native asset acronym in uppercase.
    // forge-lint: disable-next-line(mixed-case-function)
    function unlockETH(uint256 value) external;
}

/// @notice Relays actual OP/Base native sucker withdrawals through their deployed Ethereum messenger.
/// @dev Models only the Portal caller and its consensus-established L2 messenger context. Source logs, messenger
/// authentication, replay tracking, escrow transfers and both suckers use real code. This does not prove Portal
/// withdrawal inclusion, finality, outer replay protection or relayer operation. Native value comes from the
/// Portal's actual escrow or its configured ETHLockbox via the same unlock call made during finalization; balances
/// and code are never fabricated. Callers must not install unrelated mocks: Foundry clears mocks as one scope.
// forge-lint: disable-next-line(multi-contract-file)
abstract contract StickyJbxOptimismTransport is Test {
    /// @notice The complete version-1 relay arguments emitted by the deployed L2 messenger.
    struct OpMessage {
        address sender;
        address target;
        bytes data;
        uint256 nonce;
        uint256 minimumGas;
        uint256 value;
    }

    address internal constant _OP_TRANSPORT_L2_MESSENGER = 0x4200000000000000000000000000000000000007;
    uint256 internal constant _OP_TRANSPORT_OPTIMISM_CHAIN_ID = 10;
    uint256 internal constant _OP_TRANSPORT_BASE_CHAIN_ID = 8453;
    bytes32 internal constant _OP_TRANSPORT_SENT_MESSAGE =
        keccak256("SentMessage(address,address,bytes,uint256,uint256)");
    bytes32 internal constant _OP_TRANSPORT_SENT_VALUE = keccak256("SentMessageExtension1(address,uint256)");

    /// @notice Captures the sole native root sent by the source during its actual toRemote call.
    /// @param logs The logs recorded around that source call, without synthetic or reconstructed entries.
    /// @param source The deployed L2 sucker whose outbox was sent.
    /// @param value The native outbox balance actually submitted by toRemote, checked against both emitted events.
    /// @return message The original sender, target, calldata, versioned nonce, gas and native value.
    function _captureOpMessage(
        Vm.Log[] memory logs,
        JBOptimismSucker source,
        uint256 value
    )
        internal
        view
        returns (OpMessage memory message)
    {
        return _captureOpMessageFor({
            logs: logs, source: source, value: value, remoteToken: bytes32(uint256(uint160(JBConstants.NATIVE_TOKEN)))
        });
    }

    /// @notice Captures a real sucker-root message while distinguishing ERC-20 backing from native message value.
    /// @param logs The actual source logs recorded around submission.
    /// @param source The registered L2 sucker submitting the root.
    /// @param value The native value attached to the messenger call, zero for ERC-20-backed roots.
    /// @param remoteToken The selected remote backing token encoded in the root.
    /// @return message The complete emitted messenger call for the sucker root.
    function _captureOpMessageFor(
        Vm.Log[] memory logs,
        JBOptimismSucker source,
        uint256 value,
        bytes32 remoteToken
    )
        internal
        view
        returns (OpMessage memory message)
    {
        assertTrue(
            block.chainid == _OP_TRANSPORT_OPTIMISM_CHAIN_ID || block.chainid == _OP_TRANSPORT_BASE_CHAIN_ID,
            "capture must be on Optimism or Base"
        );
        assertEq(source.peerChainId(), 1, "source peer must be Ethereum");
        assertEq(address(source.OPMESSENGER()), _OP_TRANSPORT_L2_MESSENGER, "canonical L2 messenger");
        assertGt(_OP_TRANSPORT_L2_MESSENGER.code.length, 0, "source messenger must be deployed");

        bytes32 peer = source.peer();
        uint256 count = 0;
        for (uint256 i = 0; i < logs.length; ++i) {
            Vm.Log memory entry = logs[i];
            if (
                entry.emitter != _OP_TRANSPORT_L2_MESSENGER || entry.topics.length == 0
                    || entry.topics[0] != _OP_TRANSPORT_SENT_MESSAGE
            ) continue;
            (address sender, bytes memory data, uint256 nonce, uint256 minimumGas) =
                abi.decode(entry.data, (address, bytes, uint256, uint256));
            if (sender != address(source)) continue;
            assertEq(entry.topics.length, 2, "exact messenger event topics");
            assertLt(i + 1, logs.length, "sent message must include its native value event");
            Vm.Log memory extension = logs[i + 1];
            assertEq(extension.emitter, entry.emitter, "value event messenger");
            assertEq(extension.topics.length, 2, "exact value event topics");
            assertEq(extension.topics[0], _OP_TRANSPORT_SENT_VALUE, "paired native value event");
            assertEq(extension.topics[1], bytes32(uint256(uint160(sender))), "value event source sucker");
            assertEq(extension.data.length, 32, "exact native value encoding");
            message = OpMessage({
                sender: sender,
                target: address(uint160(uint256(entry.topics[1]))),
                data: data,
                nonce: nonce,
                minimumGas: minimumGas,
                value: abi.decode(extension.data, (uint256))
            });
            assertEq(entry.topics[1], peer, "captured target must be the source peer");
            assertEq(entry.data, abi.encode(sender, data, nonce, minimumGas), "exact source event encoding");
            assertEq(message.value, value, "actual emitted native value must equal the expected messenger value");
            assertEq(nonce >> 240, 1, "version-1 messenger nonce");
            _checkOpRoot({message: message, remoteToken: remoteToken});
            ++count;
        }
        assertEq(count, 1, "exactly one actual sucker root message must be captured");
    }

    /// @notice Supplies a finalized Portal context and executes the real L1 messenger with existing escrow.
    /// @dev The normal remoteSender is message.sender. A different sender tests the sucker's peer rejection;
    /// that authenticated messenger call keeps its value in the messenger and records a failed message.
    /// Retrying such a failure requires the identical relay arguments and zero value from an ordinary caller,
    /// not another Portal delivery. Tests that deliberately corrupt the sender should restore their fork snapshot.
    /// @return success Whether the real messenger recorded successful target execution, not just outer call success.
    function _deliverOpMessage(OpMessage memory message, address remoteSender) internal returns (bool success) {
        JBOptimismSucker destination = JBOptimismSucker(payable(message.target));
        address portal = _opPortal(destination);
        IStickyJbxOpMessenger messenger = IStickyJbxOpMessenger(address(destination.OPMESSENGER()));
        assertEq(destination.peer(), bytes32(uint256(uint160(message.sender))), "captured source must be the peer");
        _checkOpRoot({message: message, remoteToken: bytes32(uint256(uint160(JBConstants.NATIVE_TOKEN)))});

        uint256 escrowBefore = portal.balance;
        uint256 harnessBefore = address(this).balance;
        uint256 messengerBefore = address(messenger).balance;
        uint256 destinationBefore = message.target.balance;
        // At the pinned release OP's Portal 5.8.0 unlocks the complete withdrawal value from ethLockbox.
        // Base's Portal 6.0.1 has no such getter and retains its native escrow in the Portal itself.
        address lockbox = address(0);
        try IStickyJbxOpPortal(portal).ethLockbox() returns (address configured) {
            lockbox = configured;
        } catch {}
        uint256 lockboxBefore = lockbox == address(0) ? 0 : lockbox.balance;
        uint256 unlocked = lockbox == address(0) ? 0 : message.value;
        if (lockbox != address(0)) {
            assertTrue(
                IStickyJbxOpSystemConfig(IStickyJbxOpPortal(portal).systemConfig())
                    .isFeatureEnabled(bytes32("ETH_LOCKBOX")),
                "production Portal must use its configured lockbox"
            );
            assertGt(lockbox.code.length, 0, "configured native lockbox must be deployed");
            assertTrue(IStickyJbxOpLockbox(lockbox).authorizedPortals(portal), "actual Portal must be authorized");
            assertGe(lockboxBefore, unlocked, "deployed lockbox escrow must cover captured value");
            // Production unlock precedes the l2Sender assignment; the lockbox checks the real idle Portal context.
            if (unlocked != 0) {
                vm.prank(portal);
                IStickyJbxOpLockbox(lockbox).unlockETH(unlocked);
            }
            assertEq(lockbox.balance, lockboxBefore - unlocked, "exact lockbox escrow debit");
        }
        assertEq(portal.balance, escrowBefore + unlocked, "exact Portal credit from actual lockbox");
        assertGe(portal.balance, message.value, "deployed Portal escrow must cover captured value");
        vm.mockCall({
            callee: portal,
            data: abi.encodeCall(IStickyJbxOpPortal.l2Sender, ()),
            returnData: abi.encode(_OP_TRANSPORT_L2_MESSENGER),
            injectCode: false
        });
        vm.prank(portal);
        // The actual destination messenger was bound to the captured peer; value is debited from real Portal escrow.
        // forge-lint: disable-next-line(arbitrary-send-eth)
        messenger.relayMessage{value: message.value}(
            message.nonce, remoteSender, message.target, message.value, message.minimumGas, message.data
        );
        vm.clearMockedCalls();

        bytes32 messageHash = _opMessageHash(message, remoteSender);
        success = messenger.successfulMessages(messageHash);
        assertEq(portal.balance, escrowBefore + unlocked - message.value, "exact native Portal escrow debit");
        assertEq(address(this).balance, harnessBefore, "test harness must not fund the withdrawal");
        assertEq(
            message.target.balance, destinationBefore + (success ? message.value : 0), "exact native sucker credit"
        );
        assertEq(
            address(messenger).balance,
            messengerBefore + (success ? 0 : message.value),
            "failed target retains its original value in the messenger"
        );
        assertEq(
            (lockbox == address(0) ? 0 : lockbox.balance) + portal.balance + address(messenger).balance
                + message.target.balance,
            lockboxBefore + escrowBefore + messengerBefore + destinationBefore,
            "lockbox, Portal, messenger and recipient conserve existing native escrow"
        );
        if (!success) assertTrue(messenger.failedMessages(messageHash), "real messenger must record target failure");
    }

    /// @notice Resolves the actual escrow Portal through the deployed destination messenger's getter.
    /// @dev PORTAL is the deployed Bedrock legacy alias of portal; no configured or guessed Portal address is used.
    function _opPortal(JBOptimismSucker destination) internal view returns (address portal) {
        assertEq(block.chainid, 1, "delivery must be on Ethereum");
        assertGt(address(destination).code.length, 0, "destination sucker must be deployed");
        uint256 peerChainId = destination.peerChainId();
        assertTrue(
            peerChainId == _OP_TRANSPORT_OPTIMISM_CHAIN_ID || peerChainId == _OP_TRANSPORT_BASE_CHAIN_ID,
            "peer must be Optimism or Base"
        );
        IStickyJbxOpMessenger messenger = IStickyJbxOpMessenger(address(destination.OPMESSENGER()));
        assertGt(address(messenger).code.length, 0, "destination messenger must be deployed");
        assertEq(messenger.OTHER_MESSENGER(), _OP_TRANSPORT_L2_MESSENGER, "paired L2 messenger");
        portal = messenger.PORTAL();
        assertGt(portal.code.length, 0, "native escrow Portal must be deployed");
    }

    /// @notice The canonical messenger hash, also usable for direct unauthorized/replay calls in tests.
    function _opMessageHash(OpMessage memory message, address remoteSender) internal pure returns (bytes32) {
        return keccak256(
            abi.encodeCall(
                IStickyJbxOpMessenger.relayMessage,
                (message.nonce, remoteSender, message.target, message.value, message.minimumGas, message.data)
            )
        );
    }

    /// @notice Requires exact source calldata and checks the backing asset independently of native transport value.
    /// @param message The complete emitted source call.
    /// @param remoteToken The expected remote backing token, encoded as bytes32.
    function _checkOpRoot(OpMessage memory message, bytes32 remoteToken) private pure {
        // Intentionally select the first four bytes; canonical re-encoding below checks the full payload.
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(bytes4(message.data), JBSucker.fromRemote.selector, "sucker root delivery only");
        JBMessageRoot memory root = abi.decode(Bytes.slice({buffer: message.data, start: 4}), (JBMessageRoot));
        assertEq(root.token, remoteToken, "selected remote backing token");
        if (remoteToken == bytes32(uint256(uint160(JBConstants.NATIVE_TOKEN)))) {
            assertEq(root.amount, message.value, "actual native root amount");
        } else {
            assertEq(message.value, 0, "ERC-20 backing is transported separately from the native messenger value");
        }
        assertEq(message.data, abi.encodeCall(JBSucker.fromRemote, (root)), "preserve complete source root calldata");
    }
}

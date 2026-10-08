// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {JBPermissioned} from "@bananapus/core-v6/src/abstract/JBPermissioned.sol";
import {IJBController} from "@bananapus/core-v6/src/interfaces/IJBController.sol";
import {IJBPermissioned} from "@bananapus/core-v6/src/interfaces/IJBPermissioned.sol";
import {JBRulesetConfig} from "@bananapus/core-v6/src/structs/JBRulesetConfig.sol";
import {JBPermissionIds} from "@bananapus/permission-ids-v6/src/JBPermissionIds.sol";
import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";

import {StickyHook} from "../../src/StickyHook.sol";
import {StickyJbxDeployedFork} from "./helpers/StickyJbxDeployedFork.sol";
import {StickyRealProjectContext} from "./helpers/StickyRealProjectFork.sol";

/// @notice Exercises real deployed authority contracts, without impersonating the trusted forwarder or operator.
/// @dev Signatures use generated test keys on the pinned local fork; no live wallet or transaction is involved.
contract StickyJbxAuthorityForkTest is StickyJbxDeployedFork {
    address internal constant _FORWARDER = 0x3bA60b60933916a7C87D0860DcEE62a0CE34E3e2;
    address internal constant _OPERATOR = 0xB853758A70a6b4216c09f1d071eA2344AbA0a34f;
    address internal constant _PERMISSIONS = 0xf92AC1aB5A00033E35a3975739124F61928C36B0;

    // Full runtime hashes from independent eth_getCode reads at the fixture's pinned Ethereum block 26_149_188.
    // Artifact deployedBytecode contains immutable placeholders and is not a valid runtime identity.
    // These pins and the getter checks below do not claim complete source-to-bytecode equivalence.
    bytes32 internal constant _FORWARDER_CODEHASH = 0x5ea5f923538e42ae3888d77a2aaad0c5b0dbdb01cbffe5aa1f9bf833da29e411;
    bytes32 internal constant _OPERATOR_CODEHASH = 0x2d7a2689733a2594c855a005061131d8bc1fb6b5ba6ff9c47cf56df062ca16d4;
    bytes32 internal constant _PERMISSIONS_CODEHASH =
        0x302c93606d1149f38b112417c25457d2c436606f1251ecff4eed32ec067aee4c;
    bytes32 internal constant _REQUEST_TYPEHASH = keccak256(
        "ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,uint48 deadline,bytes data)"
    );

    StickyRealProjectContext internal _context;
    ERC2771Forwarder internal _forwarder;
    StickyHook internal _hook;
    uint256 internal _projectId;
    uint256 internal _signerKey;
    address internal _signer;
    address internal _relayer;
    address internal _helper;

    function setUp() public {
        _context = _deployedJbxContext();
        assertEq(_FORWARDER.codehash, _FORWARDER_CODEHASH, "deployed forwarder runtime");
        assertEq(_OPERATOR.codehash, _OPERATOR_CODEHASH, "deployed operator runtime");
        assertEq(_PERMISSIONS.codehash, _PERMISSIONS_CODEHASH, "deployed permissions runtime");
        assertEq(_context.core.controller.OMNICHAIN_RULESET_OPERATOR(), _OPERATOR, "controller operator");
        assertEq(
            address(IJBPermissioned(address(_context.core.controller)).PERMISSIONS()),
            _PERMISSIONS,
            "controller permissions"
        );
        assertEq(address(IJBPermissioned(_OPERATOR).PERMISSIONS()), _PERMISSIONS, "operator permissions");
        assertEq(ERC2771Context(address(_context.core.controller)).trustedForwarder(), _FORWARDER);
        assertEq(ERC2771Context(_OPERATOR).trustedForwarder(), _FORWARDER);
        assertEq(ERC2771Context(_PERMISSIONS).trustedForwarder(), _FORWARDER);

        _forwarder = ERC2771Forwarder(_FORWARDER);
        _hook = StickyHook(_context.suite.hook);
        assertEq(_hook.trustedForwarder(), _FORWARDER, "Sticky hook forwarder");
        (_projectId,) = _launchSticky({context: _context, soulbound: false, cashOutTaxRate: 0});
        (_signer, _signerKey) = makeAddrAndKey("Sticky JBX authority signer");
        _relayer = makeAddr("Sticky JBX authority relayer");
        _helper = makeAddr("Sticky JBX authority helper");
    }

    function test_deployedForwarder_validSignatureAndReplay() public {
        ERC2771Forwarder.ForwardRequestData memory request = _signedRequest(_signerKey);
        uint256 nonce = _forwarder.nonces(_signer);
        assertTrue(_forwarder.verify(request), "valid signed intent");
        vm.prank(_relayer);
        _forwarder.execute(request);
        assertTrue(_hook.isTrustedSenderOf(_projectId, _signer, _helper), "signer owns relayed change");
        assertFalse(_hook.isTrustedSenderOf(_projectId, _relayer, _helper), "relayer gets no holder authority");
        assertFalse(_hook.isTrustedSenderOf(_projectId, _FORWARDER, _helper), "forwarder gets no holder authority");
        assertEq(_forwarder.nonces(_signer), nonce + 1, "single nonce consumed");

        assertFalse(_forwarder.verify(request), "same signature cannot replay");
        vm.expectPartialRevert(ERC2771Forwarder.ERC2771ForwarderInvalidSigner.selector);
        vm.prank(_relayer);
        _forwarder.execute(request);
        assertEq(_forwarder.nonces(_signer), nonce + 1, "replay consumes no further nonce");
        assertTrue(_hook.isTrustedSenderOf(_projectId, _signer, _helper), "replay leaves state unchanged");
    }

    function test_deployedForwarder_wrongSignerCannotAuthorizeHolder() public {
        (address stranger, uint256 strangerKey) = makeAddrAndKey("Sticky JBX authority wrong signer");
        ERC2771Forwarder.ForwardRequestData memory request = _signedRequest(strangerKey);
        assertFalse(_forwarder.verify(request));
        vm.expectRevert(
            abi.encodeWithSelector(ERC2771Forwarder.ERC2771ForwarderInvalidSigner.selector, stranger, _signer)
        );
        vm.prank(_relayer);
        _forwarder.execute(request);
        _assertRejectedRequestUnchanged();
    }

    function test_deployedForwarder_changedCalldataInvalidatesSignature() public {
        ERC2771Forwarder.ForwardRequestData memory request = _signedRequest(_signerKey);
        request.data = abi.encodeCall(StickyHook.setTrustedSenderFor, (_projectId, _relayer, true));
        assertFalse(_forwarder.verify(request));
        vm.expectPartialRevert(ERC2771Forwarder.ERC2771ForwarderInvalidSigner.selector);
        vm.prank(_relayer);
        _forwarder.execute(request);
        _assertRejectedRequestUnchanged();
        assertFalse(_hook.isTrustedSenderOf(_projectId, _signer, _relayer), "tampered beneficiary stays untrusted");
    }

    function test_deployedForwarder_expiredSignatureCannotAuthorizeHolder() public {
        ERC2771Forwarder.ForwardRequestData memory request = _signedRequest(_signerKey);
        vm.warp(uint256(request.deadline) + 1);
        assertFalse(_forwarder.verify(request));
        vm.expectRevert(
            abi.encodeWithSelector(ERC2771Forwarder.ERC2771ForwarderExpiredRequest.selector, request.deadline)
        );
        vm.prank(_relayer);
        _forwarder.execute(request);
        _assertRejectedRequestUnchanged();
    }

    function test_deployedOmnichainOperator_cannotQueueForStickyAsStranger() public {
        uint256 latest = _context.core.controller.RULESETS().latestRulesetIdOf(_projectId);
        address owner = _context.core.controller.PROJECTS().ownerOf(_projectId);
        assertEq(owner, _context.suite.deployer, "Sticky retains its permanent owner");
        JBRulesetConfig[] memory configurations = new JBRulesetConfig[](1);
        vm.expectRevert(
            abi.encodeWithSelector(
                JBPermissioned.JBPermissioned_Unauthorized.selector,
                owner,
                _relayer,
                _projectId,
                JBPermissionIds.QUEUE_RULESETS
            )
        );
        vm.prank(_relayer);
        // This three-argument selector is shared by the controller and the real omnichain deployer.
        // Its one-word return type is irrelevant because the permission check must revert before any return.
        IJBController(_OPERATOR).queueRulesetsOf(_projectId, configurations, "unauthorized Sticky rewrite");
        assertEq(_context.core.controller.RULESETS().latestRulesetIdOf(_projectId), latest, "ruleset unchanged");
    }

    function _signedRequest(uint256 signerKey)
        internal
        view
        returns (ERC2771Forwarder.ForwardRequestData memory request)
    {
        request.from = _signer;
        request.to = address(_hook);
        request.gas = 150_000;
        request.deadline = uint48(block.timestamp + 1 hours);
        request.data = abi.encodeCall(StickyHook.setTrustedSenderFor, (_projectId, _helper, true));
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Juicebox"),
                keccak256("1"),
                block.chainid,
                address(_forwarder)
            )
        );
        bytes32 intent = keccak256(
            abi.encode(
                _REQUEST_TYPEHASH,
                request.from,
                request.to,
                request.value,
                request.gas,
                _forwarder.nonces(request.from),
                request.deadline,
                keccak256(request.data)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, keccak256(abi.encodePacked(hex"1901", domain, intent)));
        request.signature = abi.encodePacked(r, s, v);
    }

    function _assertRejectedRequestUnchanged() internal view {
        assertEq(_forwarder.nonces(_signer), 0, "invalid request consumes no nonce");
        assertFalse(_hook.isTrustedSenderOf(_projectId, _signer, _helper), "invalid request grants no authority");
    }
}

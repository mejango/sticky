// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IStickyHook} from "../src/interfaces/IStickyHook.sol";
import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";

import {IJBController} from "@bananapus/core-v6/src/interfaces/IJBController.sol";
import {IJBToken} from "@bananapus/core-v6/src/interfaces/IJBToken.sol";
import {TestBaseWorkflow} from "@bananapus/core-v6/test/helpers/TestBaseWorkflow.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {StickyDeployer} from "../src/StickyDeployer.sol";
import {StickyHook} from "../src/StickyHook.sol";
import {StickyToken} from "../src/StickyToken.sol";

import {StickyTestFeeReceiver} from "./helpers/StickyTestFeeReceiver.sol";
import {StickyTestLauncher} from "./helpers/StickyTestLauncher.sol";
import {StickyTestSingletonDeployment} from "./helpers/StickyTestSingletonDeployment.sol";

/// @notice Creation fees retain their original payer through Sticky's immutable project owner.
contract StickyDeployerRegressionTest is TestBaseWorkflow {
    //*********************************************************************//
    // ----------------------- internal constants ------------------------ //
    //*********************************************************************//

    /// @notice The project creation fee configured on core.
    uint256 internal constant _FEE = 0.0001 ether;

    //*********************************************************************//
    // -------------------- internal stored properties ------------------- //
    //*********************************************************************//

    /// @notice The Sticky factory.
    StickyDeployer internal _deployer;

    /// @notice The account funding each launch.
    // forge-lint: disable-next-line(function-init-state)
    address internal _launcher = makeAddr("launcher");

    /// @notice The observer at the fee-receiver boundary.
    StickyTestFeeReceiver internal _receiver;

    //*********************************************************************//
    // ----------------------- public transactions ----------------------- //
    //*********************************************************************//

    /// @notice Configures core's actual fee path with an observer at the fee-receiver boundary.
    function setUp() public override {
        super.setUp();
        _receiver = new StickyTestFeeReceiver();
        vm.prank(jbProjects().owner());
        jbProjects().setCreationFee({fee: _FEE, receiver: payable(address(_receiver))});
        _deployer =
            StickyTestSingletonDeployment.deployDeployer({controller: jbController(), terminal: jbMultiTerminal()});
        vm.deal(_launcher, _FEE);
    }

    /// @notice The injected hook permanently authorizes this factory and retains canonical callback bindings.
    function test_constructorBindsExplicitHook() public view {
        assertEq(_deployer.HOOK().DEPLOYER(), address(_deployer));
        assertEq(address(_deployer.HOOK().DIRECTORY()), address(jbDirectory()));
        assertEq(ERC2771Context(address(_deployer.HOOK())).trustedForwarder(), _deployer.trustedForwarder());
    }

    /// @notice Counterfactual hook authority must still identify an accessible nonzero deployer.
    function test_hookRejectsZeroDeploymentAuthority() public {
        vm.expectRevert(abi.encodeWithSelector(StickyHook.StickyHook_InvalidDeploymentAuthority.selector, address(0)));
        new StickyHook({
            directory: jbDirectory(), deploymentAuthority: address(0), trustedForwarder: trustedForwarder()
        });
    }

    /// @notice Missing hook code cannot become the project's accounting boundary.
    function test_constructorRejectsMissingHookCode() public {
        address missing = makeAddr("missing hook");
        vm.expectRevert(abi.encodeWithSelector(StickyDeployer.StickyDeployer_InvalidHook.selector, missing));
        new StickyDeployer({controller: jbController(), terminal: jbMultiTerminal(), hook: IStickyHook(missing)});
    }

    /// @notice A genuine hook bound to another factory cannot authorize this factory's launches.
    function test_constructorRejectsWrongHookParent() public {
        IStickyHook wrongHook = _deployer.HOOK();
        vm.expectRevert(abi.encodeWithSelector(StickyDeployer.StickyDeployer_InvalidHook.selector, address(wrongHook)));
        new StickyDeployer({controller: jbController(), terminal: jbMultiTerminal(), hook: wrongHook});
    }

    /// @notice A hook cannot authenticate terminals against a different directory.
    function test_constructorRejectsWrongHookDirectory() public {
        IStickyHook preparedHook = StickyTestSingletonDeployment.prepareHook(jbController());
        vm.mockCall(
            address(preparedHook), abi.encodeCall(IStickyHook.DIRECTORY, ()), abi.encode(makeAddr("wrong directory"))
        );
        vm.expectRevert(
            abi.encodeWithSelector(StickyDeployer.StickyDeployer_InvalidHook.selector, address(preparedHook))
        );
        new StickyDeployer({controller: jbController(), terminal: jbMultiTerminal(), hook: preparedHook});
    }

    /// @notice The hook and factory cannot interpret forwarded signers under different trust policies.
    function test_constructorRejectsWrongHookForwarder() public {
        IStickyHook preparedHook = StickyTestSingletonDeployment.prepareHook(jbController());
        vm.mockCall(
            address(preparedHook),
            abi.encodeCall(ERC2771Context.trustedForwarder, ()),
            abi.encode(makeAddr("wrong forwarder"))
        );
        vm.expectRevert(
            abi.encodeWithSelector(StickyDeployer.StickyDeployer_InvalidHook.selector, address(preparedHook))
        );
        new StickyDeployer({controller: jbController(), terminal: jbMultiTerminal(), hook: preparedHook});
    }

    /// @notice Only the constructor-selected authority may complete an initially unbound hook.
    function test_hookBindingIsAuthorizedAndOneShot() public {
        IStickyHook hook = StickyTestSingletonDeployment.prepareHook(jbController());
        StickyDeployer parent =
            new StickyDeployer({controller: jbController(), terminal: jbMultiTerminal(), hook: hook});
        address stranger = makeAddr("binding stranger");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(StickyHook.StickyHook_BindingUnauthorized.selector, stranger));
        hook.setDeployer(address(parent));
        assertEq(hook.DEPLOYER(), address(0));
        hook.setDeployer(address(parent));
        assertEq(hook.DEPLOYER(), address(parent));
        vm.expectRevert(abi.encodeWithSelector(StickyHook.StickyHook_AlreadyBound.selector, address(parent)));
        hook.setDeployer(address(parent));
    }

    /// @notice Missing parent code cannot complete a hook binding.
    function test_hookBindingRejectsMissingParentCode() public {
        IStickyHook hook = StickyTestSingletonDeployment.prepareHook(jbController());
        address missing = makeAddr("missing hook parent");
        vm.expectRevert(abi.encodeWithSelector(StickyHook.StickyHook_InvalidDeployer.selector, missing));
        hook.setDeployer(missing);
        assertEq(hook.DEPLOYER(), address(0));
    }

    /// @notice A parent's different immutable hook cannot acquire this hook's accounting authority.
    function test_hookBindingRejectsWrongReciprocalReference() public {
        IStickyHook hook = StickyTestSingletonDeployment.prepareHook(jbController());
        vm.expectRevert(abi.encodeWithSelector(StickyHook.StickyHook_InvalidDeployer.selector, address(_deployer)));
        hook.setDeployer(address(_deployer));
        assertEq(hook.DEPLOYER(), address(0));
    }

    /// @notice One-time binding verifies the parent controller's actual terminal directory.
    function test_hookBindingRejectsWrongParentDirectory() public {
        IStickyHook hook = StickyTestSingletonDeployment.prepareHook(jbController());
        StickyDeployer parent =
            new StickyDeployer({controller: jbController(), terminal: jbMultiTerminal(), hook: hook});
        vm.mockCall(
            address(parent.CONTROLLER()),
            abi.encodeCall(IJBController.DIRECTORY, ()),
            abi.encode(makeAddr("wrong binding directory"))
        );
        vm.expectRevert(abi.encodeWithSelector(StickyHook.StickyHook_InvalidDeployer.selector, address(parent)));
        hook.setDeployer(address(parent));
        assertEq(hook.DEPLOYER(), address(0));
    }

    /// @notice One-time binding verifies the parent interprets forwarded signers under the same trust policy.
    function test_hookBindingRejectsWrongParentForwarder() public {
        IStickyHook hook = StickyTestSingletonDeployment.prepareHook(jbController());
        StickyDeployer parent =
            new StickyDeployer({controller: jbController(), terminal: jbMultiTerminal(), hook: hook});
        vm.mockCall(
            address(parent),
            abi.encodeCall(ERC2771Context.trustedForwarder, ()),
            abi.encode(makeAddr("wrong binding forwarder"))
        );
        vm.expectRevert(abi.encodeWithSelector(StickyHook.StickyHook_InvalidDeployer.selector, address(parent)));
        hook.setDeployer(address(parent));
        assertEq(hook.DEPLOYER(), address(0));
    }

    /// @notice Launch failure while unbound rolls back core ownership and creation-fee state.
    function test_unboundHookLaunchRollsBack() public {
        IStickyHook hook = StickyTestSingletonDeployment.prepareHook(jbController());
        StickyDeployer parent =
            new StickyDeployer({controller: jbController(), terminal: jbMultiTerminal(), hook: hook});
        uint256 projectCount = jbProjects().count();
        uint256 balanceBefore = _launcher.balance;
        vm.prank(_launcher);
        vm.expectRevert(
            abi.encodeWithSelector(StickyHook.StickyHook_Unauthorized.selector, address(parent), address(0))
        );
        parent.deployStickyFor{value: _FEE}({
            stakedToken: IERC20Metadata(address(usdcToken())),
            name: "Unbound",
            symbol: "stU",
            projectUri: "",
            cashOutTaxRate: 0,
            granters: new address[](0),
            soulbound: false
        });
        assertEq(jbProjects().count(), projectCount);
        assertEq(_launcher.balance, balanceBefore);
        assertEq(hook.DEPLOYER(), address(0));
    }

    /// @notice The nested-share restriction is local to one factory; another factory can put transferable shares
    /// and their reward weight in terminal custody, even though the nested holder can still recover their shares.
    function test_crossFactoryStickySharesCanAccrueTerminalRewardWeight() public {
        StickyDeployer otherDeployer =
            StickyTestSingletonDeployment.deployDeployer({controller: jbController(), terminal: jbMultiTerminal()});
        vm.deal(_launcher, 2 * _FEE);
        vm.startPrank(_launcher);
        // forge-lint: disable-next-item(arbitrary-send-eth)
        uint256 underlyingProjectId = _deployer.deployStickyFor{value: _FEE}({
            stakedToken: IERC20Metadata(address(usdcToken())),
            name: "Transferable Sticky",
            symbol: "stUSD",
            projectUri: "",
            cashOutTaxRate: 0,
            granters: new address[](0),
            soulbound: false
        });
        StickyToken underlyingShares = StickyToken(address(jbTokens().tokenOf(underlyingProjectId)));
        // A different hook has no registration for this otherwise genuine Sticky share token.
        assertEq(otherDeployer.HOOK().tokenOf(underlyingProjectId), address(0));
        // forge-lint: disable-next-item(arbitrary-send-eth)
        uint256 nestedProjectId = otherDeployer.deployStickyFor{value: _FEE}({
            stakedToken: IERC20Metadata(address(underlyingShares)),
            name: "Nested Sticky",
            symbol: "ststUSD",
            projectUri: "",
            cashOutTaxRate: 0,
            granters: new address[](0),
            soulbound: false
        });
        // forge-lint: disable-next-line(literal-instead-of-constant)
        uint256 amount = 1e6;
        usdcToken().mint({_to: _launcher, _amount: amount});
        assertTrue(usdcToken().approve({spender: address(jbMultiTerminal()), value: amount}));
        uint256 underlyingCount = jbMultiTerminal().pay({
            projectId: underlyingProjectId,
            token: address(usdcToken()),
            amount: amount,
            beneficiary: _launcher,
            minReturnedTokens: amount,
            memo: "",
            metadata: bytes("")
        });
        assertTrue(underlyingShares.approve({spender: address(jbMultiTerminal()), value: underlyingCount}));
        uint256 nestedCount = jbMultiTerminal().pay({
            projectId: nestedProjectId,
            token: address(underlyingShares),
            amount: underlyingCount,
            beneficiary: _launcher,
            minReturnedTokens: underlyingCount,
            memo: "",
            metadata: bytes("")
        });
        // Reward snapshots attribute the nested collateral to the terminal, which has no reward-claim method.
        assertEq(underlyingShares.balanceOf(address(jbMultiTerminal())), underlyingCount);
        assertEq(underlyingShares.getVotes(address(jbMultiTerminal())), underlyingCount);
        assertEq(underlyingShares.getVotes(_launcher), 0);
        // This composability limitation does not itself prevent a zero-tax nested holder from exiting.
        uint256 reclaimed = jbMultiTerminal().cashOutTokensOf({
            holder: _launcher,
            projectId: nestedProjectId,
            cashOutCount: nestedCount,
            tokenToReclaim: address(underlyingShares),
            minTokensReclaimed: underlyingCount,
            beneficiary: payable(_launcher),
            metadata: bytes("")
        });
        vm.stopPrank();
        assertEq(reclaimed, underlyingCount);
        assertEq(underlyingShares.balanceOf(_launcher), underlyingCount);
        assertEq(underlyingShares.getVotes(address(jbMultiTerminal())), 0);
    }

    /// @notice Fee-project tokens belong to the funding launcher while Sticky retains permanent NFT ownership.
    function test_creationFeeCreditsLauncher() public {
        uint256 projectId = _launch();
        assertEq(_receiver.payers(0), _launcher);
        assertEq(jbProjects().ownerOf(projectId), address(_deployer));
        _assertPayerScopesCleared();
    }

    /// @notice A launch forwarded by another payer tracker retains the upstream account's attribution.
    function test_creationFeeCreditsUpstreamLauncher() public {
        StickyTestLauncher forwarder = new StickyTestLauncher();
        vm.prank(_launcher);
        uint256 projectId =
        // forge-lint: disable-next-line(arbitrary-send-eth)
        forwarder.launch{value: _FEE}({deployer: _deployer, underlying: IERC20Metadata(address(usdcToken()))});
        assertEq(_receiver.payers(0), _launcher);
        assertEq(jbProjects().ownerOf(projectId), address(_deployer));
        assertEq(forwarder.originalPayer(), address(0));
        _assertPayerScopesCleared();
    }

    /// @notice A nested launch gets its own payer and restores the outer factory scope before returning.
    function test_nestedLaunchRestoresOuterPayer() public {
        _receiver.configureReentry({deployer: _deployer, underlying: IERC20Metadata(address(usdcToken()))});
        uint256 projectId = _launch();
        assertEq(_receiver.payers(0), _launcher);
        assertEq(_receiver.payers(1), address(_receiver));
        assertEq(_receiver.restoredPayer(), _launcher);
        assertNotEq(_receiver.nestedProjectId(), projectId);
        assertEq(jbProjects().ownerOf(projectId), address(_deployer));
        assertEq(jbProjects().ownerOf(_receiver.nestedProjectId()), address(_deployer));
        _assertPayerScopesCleared();
    }

    /// @notice The deployer rejects project NFTs minted to it outside its own launch.
    function test_rejectsProjectMintedOutsideLaunch() public {
        vm.deal(address(this), _FEE);
        uint256 expectedId = jbProjects().count() + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                StickyDeployer.StickyDeployer_UnexpectedNft.selector, address(jbProjects()), address(0), expectedId
            )
        );
        // forge-lint: disable-next-line(arbitrary-send-eth)
        jbProjects().createFor{value: _FEE}(address(_deployer));
    }

    /// @notice Another Sticky project's shares cannot be the staked token, since the terminal would hold unclaimable
    /// reward weight in that project's distributor rounds.
    function test_rejectsStickyTokenAsStakedToken() public {
        uint256 projectId = _launch();
        IJBToken shares = jbTokens().tokenOf(projectId);
        vm.deal(_launcher, _FEE);
        vm.expectRevert(
            abi.encodeWithSelector(
                StickyDeployer.StickyDeployer_StakedTokenIsSticky.selector, address(shares), projectId
            )
        );
        vm.prank(_launcher);
        // forge-lint: disable-next-item(arbitrary-send-eth,unused-return)
        _deployer.deployStickyFor{value: _FEE}({
            stakedToken: IERC20Metadata(address(shares)),
            name: "Sticky Sticky",
            symbol: "stst",
            projectUri: "",
            cashOutTaxRate: 0,
            granters: new address[](0),
            soulbound: true
        });
    }

    /// @notice The deployer rejects existing project NFTs sent to it.
    function test_rejectsTransferredProjectNft() public {
        address holder = makeAddr("holder");
        vm.deal(holder, _FEE);
        vm.prank(holder);
        // forge-lint: disable-next-line(arbitrary-send-eth)
        uint256 projectId = jbProjects().createFor{value: _FEE}(holder);
        vm.expectRevert(
            abi.encodeWithSelector(
                StickyDeployer.StickyDeployer_UnexpectedNft.selector, address(jbProjects()), holder, projectId
            )
        );
        vm.prank(holder);
        jbProjects().safeTransferFrom({from: holder, to: address(_deployer), tokenId: projectId});
    }

    //*********************************************************************//
    // ---------------------- internal transactions ---------------------- //
    //*********************************************************************//

    /// @notice Launches a project from the funding account.
    /// @return projectId The new project ID.
    function _launch() internal returns (uint256 projectId) {
        vm.prank(_launcher);
        // forge-lint: disable-next-item(arbitrary-send-eth)
        return _deployer.deployStickyFor{value: _FEE}({
            stakedToken: IERC20Metadata(address(usdcToken())),
            name: "Sticky Audit",
            symbol: "stAUDIT",
            projectUri: "",
            cashOutTaxRate: 0,
            granters: new address[](0),
            soulbound: true
        });
    }

    //*********************************************************************//
    // ----------------------- internal views ---------------------------- //
    //*********************************************************************//

    /// @notice Checks that no forwarding contract retains a fee payer after the launch returns.
    function _assertPayerScopesCleared() internal view {
        assertEq(_deployer.originalPayer(), address(0));
        assertEq(jbController().originalPayer(), address(0));
        assertEq(jbProjects().originalPayer(), address(0));
    }
}

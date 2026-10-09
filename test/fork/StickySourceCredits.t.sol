// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IJBSplitHook} from "@bananapus/core-v6/src/interfaces/IJBSplitHook.sol";
import {IJBTokens} from "@bananapus/core-v6/src/interfaces/IJBTokens.sol";
import {JBConstants} from "@bananapus/core-v6/src/libraries/JBConstants.sol";
import {JBSplitGroupIds} from "@bananapus/core-v6/src/libraries/JBSplitGroupIds.sol";
import {JBRulesetConfig} from "@bananapus/core-v6/src/structs/JBRulesetConfig.sol";
import {JBSplit} from "@bananapus/core-v6/src/structs/JBSplit.sol";
import {JBSplitGroup} from "@bananapus/core-v6/src/structs/JBSplitGroup.sol";
import {JBTerminalConfig} from "@bananapus/core-v6/src/structs/JBTerminalConfig.sol";
import {IJBSuckerRegistry} from "@bananapus/suckers-v6/src/interfaces/IJBSuckerRegistry.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {StickyDeploymentAddresses} from "../../script/structs/StickyDeploymentAddresses.sol";
import {StickyDistributor} from "../../src/StickyDistributor.sol";
import {StickyRewardReceiverFactory} from "../../src/StickyRewardReceiverFactory.sol";
import {StickySourceCollector} from "../../src/StickySourceCollector.sol";
import {StickyToken} from "../../src/StickyToken.sol";

import {StickyDeploymentHarness} from "../deployment/StickyDeploymentHarness.sol";
import {StickyJbxDeployedFork} from "./helpers/StickyJbxDeployedFork.sol";
import {StickyRealProjectContext} from "./helpers/StickyRealProjectFork.sol";

/// @notice Qualifies generic reserved-token credit custody and delayed ERC-20 settlement on real Ethereum V6 core.
/// @dev The source project and shared collector are deployed only on the pinned local fork. Existing core and Sticky
/// contracts execute their deployed code, and the JBX stake comes from real holder inventory. No token, credit,
/// runtime, or accounting storage is fabricated. This does not establish a production collector deployment.
contract StickySourceCreditsForkTest is StickyJbxDeployedFork {
    //*********************************************************************//
    // ----------------------- internal constants ------------------------ //
    //*********************************************************************//

    /// @notice The source issuance split evenly between ordinary holder credits and the reserved hook.
    uint256 internal constant _ISSUANCE = 100 ether;

    /// @notice The first permissionless settlement, in source project-token atoms.
    uint256 internal constant _PARTIAL_SETTLEMENT = 20 ether;

    /// @notice The real JBX position qualifying the destination pool for group-zero rewards.
    uint256 internal constant _STAKE = 1_000_000 ether;

    //*********************************************************************//
    // -------------------- internal stored properties ------------------- //
    //*********************************************************************//

    /// @notice The new shared source hook deployed through the production deployment helper.
    StickySourceCollector internal _collector;

    /// @notice The existing deployed reward distributor.
    StickyDistributor internal _distributor;

    /// @notice The pinned Ethereum deployment and existing JBX token.
    StickyRealProjectContext internal _ethereum;

    /// @notice The real-JBX staking holder and ordinary source-credit beneficiary.
    address internal _holder;

    /// @notice An unrelated account distributing reserved credits and triggering settlement.
    address internal _keeper;

    /// @notice The deterministic destination receiver for the Sticky JBX pool's default group.
    address internal _receiver;

    /// @notice The ordinary EOA owning the new source project and authorizing its one-time setup.
    address internal _sourceOwner;

    /// @notice The generic source project launched with no ERC-20 and no payment terminal.
    uint256 internal _sourceProjectId;

    /// @notice The locally launched Sticky JBX share token, using the existing deployed suite.
    StickyToken internal _sticky;

    /// @notice The canonical source credit and ERC-20 registry.
    IJBTokens internal _tokens;

    //*********************************************************************//
    // ---------------------- public transactions ------------------------ //
    //*********************************************************************//

    /// @notice Creates a backed JBX position, adds the shared source hook, and configures a new generic source project.
    function setUp() public {
        _ethereum = _deployedJbxContext();
        _holder = makeAddr("generic credit reward holder");
        _keeper = makeAddr("generic credit reward keeper");
        _sourceOwner = makeAddr("generic credit source owner");
        (uint256 stickyProjectId, StickyToken sticky) = _launchDeployedJbx(_ethereum, 0, false);
        _sticky = sticky;
        _distributor = StickyDistributor(payable(_ethereum.suite.distributor));
        _tokens = _ethereum.core.controller.TOKENS();
        _transferJbx(_holder, _STAKE);
        _stake(_ethereum, stickyProjectId, _holder, _holder, _STAKE);
        vm.roll(vm.getBlockNumber() + 1);

        // Preserve existing shared snapshots while allowing this new JBX position to receive funded rewards.
        uint256 eligibleRound = _distributor.currentRound() + 2;
        assertEq(_distributor.roundSnapshotBlock(eligibleRound), 0, "fresh round before funding");
        vm.warp(_distributor.roundStartTimestamp(eligibleRound));
        vm.roll(vm.getBlockNumber() + 1);

        string memory registryArtifact =
            vm.readFile("node_modules/@bananapus/suckers-v6/deployments/ethereum/JBSuckerRegistry.json");
        _ethereum.core.registry = IJBSuckerRegistry(vm.parseJsonAddress(registryArtifact, ".address"));
        StickyDeploymentHarness deployment = new StickyDeploymentHarness();
        StickyDeploymentAddresses memory deployed = deployment.deployFor({core: _ethereum.core, destinationChainId: 1});
        assertEq(deployed.deployer, _ethereum.suite.deployer, "existing project factory preserved");
        assertEq(deployed.hook, _ethereum.suite.hook, "existing position accounting preserved");
        assertEq(deployed.distributor, _ethereum.suite.distributor, "existing reward ledger preserved");
        assertEq(deployed.rewardReceiver, _ethereum.suite.rewardReceiver, "existing receiver implementation preserved");
        assertEq(
            deployed.rewardReceiverFactory, _ethereum.suite.rewardReceiverFactory, "existing receiver factory preserved"
        );
        assertEq(deployed.autoStick, _ethereum.suite.autoStick, "existing compounding adapter preserved");
        _collector = StickySourceCollector(deployed.sourceCollector);
        _receiver = StickyRewardReceiverFactory(deployed.rewardReceiverFactory).predictReceiverOf({
            stickyToken: address(_sticky), groupId: 0
        });
        assertEq(_receiver.code.length, 0, "receiver is counterfactual before settlement");
        _sourceProjectId = _launchCreditSource();
    }

    /// @notice Real reserved credits survive a missing ERC-20 and later fund the selected pool in two exact batches.
    function test_genericReservedCredits_delayedERC20AndPartialSettlementPreserveCustody() public {
        uint256 expectedReserves = _ISSUANCE / 2;
        vm.prank(_sourceOwner);
        assertEq(
            _ethereum.core.controller
                .mintTokensOf({
                    projectId: _sourceProjectId,
                    tokenCount: _ISSUANCE,
                    beneficiary: _holder,
                    memo: "generic reserved credit qualification",
                    useReservedPercent: true
                }),
            expectedReserves,
            "ordinary holder receives half the issued credits"
        );
        assertEq(_ethereum.core.controller.pendingReservedTokenBalanceOf(_sourceProjectId), expectedReserves);

        vm.prank(_keeper);
        assertEq(
            _ethereum.core.controller.sendReservedTokensToSplitsOf({projectId: _sourceProjectId}), expectedReserves
        );
        assertEq(address(_tokens.tokenOf(_sourceProjectId)), address(0), "callback receives actual credits");
        assertEq(_tokens.creditBalanceOf(address(_collector), _sourceProjectId), expectedReserves);
        assertEq(_tokens.creditBalanceOf(_holder, _sourceProjectId), expectedReserves);
        assertEq(_tokens.creditBalanceOf(address(_ethereum.core.controller), _sourceProjectId), 0);
        assertEq(_ethereum.core.controller.pendingReservedTokenBalanceOf(_sourceProjectId), 0);
        assertEq(_tokens.totalSupplyOf(_sourceProjectId), _ISSUANCE, "reserved callback burns no credits");
        _assertPendingCustody(expectedReserves);

        vm.expectRevert(
            abi.encodeWithSelector(StickySourceCollector.StickySourceCollector_NoToken.selector, _sourceProjectId)
        );
        vm.prank(_keeper);
        _collector.settle({
            sourceProjectId: _sourceProjectId, stickyToken: address(_sticky), groupId: 0, amount: _PARTIAL_SETTLEMENT
        });
        _assertPendingCustody(expectedReserves);
        assertEq(_tokens.creditBalanceOf(address(_collector), _sourceProjectId), expectedReserves);
        assertEq(_receiver.code.length, 0, "failed settlement creates no destination");

        vm.prank(_sourceOwner);
        IERC20 reward = IERC20(
            address(
                _ethereum.core.controller
                    .deployERC20For({
                        projectId: _sourceProjectId, name: "Generic reserved reward", symbol: "GRR", salt: bytes32(0)
                    })
            )
        );
        assertEq(reward.totalSupply(), 0, "deploying ERC-20 leaves existing credits unclaimed");
        vm.prank(_keeper);
        assertEq(
            _collector.settle({
                sourceProjectId: _sourceProjectId,
                stickyToken: address(_sticky),
                groupId: 0,
                amount: _PARTIAL_SETTLEMENT
            }),
            _PARTIAL_SETTLEMENT
        );
        _assertPendingCustody(expectedReserves - _PARTIAL_SETTLEMENT);
        assertEq(_distributor.balanceOf(address(_sticky), reward), _PARTIAL_SETTLEMENT, "partial reward ledger funding");
        assertEq(reward.balanceOf(address(_distributor)), _PARTIAL_SETTLEMENT, "partial reward backing delivered");
        assertEq(reward.balanceOf(_receiver), 0, "receiver forwards the settled batch");

        vm.prank(_keeper);
        assertEq(
            _collector.settle({
                sourceProjectId: _sourceProjectId,
                stickyToken: address(_sticky),
                groupId: 0,
                amount: expectedReserves - _PARTIAL_SETTLEMENT
            }),
            expectedReserves - _PARTIAL_SETTLEMENT
        );
        _assertPendingCustody(0);
        assertEq(_tokens.creditBalanceOf(address(_collector), _sourceProjectId), 0, "all accepted credits recovered");
        assertEq(
            _tokens.creditBalanceOf(_holder, _sourceProjectId), expectedReserves, "ordinary holder credits untouched"
        );
        assertEq(_tokens.totalSupplyOf(_sourceProjectId), _ISSUANCE, "claiming credits preserves total issuance");
        assertEq(reward.totalSupply(), expectedReserves, "only accepted reserved credits materialized");
        assertEq(_distributor.balanceOf(address(_sticky), reward), expectedReserves, "full reward ledger funding");
        assertEq(reward.balanceOf(address(_distributor)), expectedReserves, "full reward backing delivered");
        assertEq(reward.balanceOf(_receiver), 0, "no settled reward stranded in receiver");
        assertEq(reward.balanceOf(_keeper), 0, "permissionless caller cannot collect principal");
        (uint208 funded,,,, uint208 totalStake) =
            _distributor.rewardRoundOf(address(_sticky), 0, reward, _distributor.currentRound());
        assertEq(funded, expectedReserves, "selected default-group round owns the full reward");
        assertEq(totalStake, _STAKE, "actual JBX stake supplies the reward denominator");
    }

    //*********************************************************************//
    // ---------------------- internal transactions ---------------------- //
    //*********************************************************************//

    /// @notice Launches a generic source whose credits use the same reserved-hook convention as deployed projects.
    /// @return projectId The new project, unrelated to the fee project and Revnet Network.
    function _launchCreditSource() internal returns (uint256 projectId) {
        JBSplit[] memory splits = new JBSplit[](1);
        splits[0] = JBSplit({
            percent: JBConstants.SPLITS_TOTAL_PERCENT,
            projectId: 0,
            beneficiary: payable(address(_sticky)),
            preferAddToBalance: false,
            lockedUntil: 0,
            hook: IJBSplitHook(address(_collector))
        });
        JBRulesetConfig[] memory rulesets = new JBRulesetConfig[](1);
        rulesets[0].metadata.reservedPercent = JBConstants.MAX_RESERVED_PERCENT / 2;
        rulesets[0].metadata.allowOwnerMinting = true;
        rulesets[0].splitGroups = new JBSplitGroup[](1);
        rulesets[0].splitGroups[0] = JBSplitGroup({groupId: JBSplitGroupIds.RESERVED_TOKENS, splits: splits});
        uint256 fee = _ethereum.core.controller.PROJECTS().creationFee();
        vm.deal(address(this), address(this).balance + fee);
        projectId = _ethereum.core.controller.launchProjectFor{value: fee}({
            owner: _sourceOwner,
            projectUri: "",
            rulesetConfigurations: rulesets,
            terminalConfigurations: new JBTerminalConfig[](0),
            memo: "generic reserved credit qualification"
        });
        assertGt(projectId, 3, "collector supports projects beyond fee project and REV");
    }

    //*********************************************************************//
    // ------------------------- internal views -------------------------- //
    //*********************************************************************//

    /// @notice Matches the selected bucket and aggregate liabilities to real token-plus-credit custody.
    /// @param expected The remaining attributed source amount, in project-token atoms.
    function _assertPendingCustody(uint256 expected) internal view {
        assertEq(_collector.pendingOf(_sourceProjectId, address(_sticky), 0), expected, "selected pool liability");
        assertEq(_collector.totalPendingOf(_sourceProjectId), expected, "aggregate source liability");
        assertEq(_tokens.totalBalanceOf(address(_collector), _sourceProjectId), expected, "actual source custody");
    }
}

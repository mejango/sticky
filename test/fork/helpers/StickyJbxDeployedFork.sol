// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IJBController} from "@bananapus/core-v6/src/interfaces/IJBController.sol";
import {IJBDirectory} from "@bananapus/core-v6/src/interfaces/IJBDirectory.sol";
import {IJBMultiTerminal} from "@bananapus/core-v6/src/interfaces/IJBMultiTerminal.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {StickyAutoStick} from "../../../src/StickyAutoStick.sol";
import {StickyDeployer} from "../../../src/StickyDeployer.sol";
import {StickyHook} from "../../../src/StickyHook.sol";
import {StickyRewardReceiverFactory} from "../../../src/StickyRewardReceiverFactory.sol";
import {StickyToken} from "../../../src/StickyToken.sol";
import {StickyCoreDeployment} from "../../../script/structs/StickyCoreDeployment.sol";
import {StickyDeploymentAddresses} from "../../../script/structs/StickyDeploymentAddresses.sol";

import {StickyRealProjectContext, StickyRealProjectFork} from "./StickyRealProjectFork.sol";

/// @notice Qualification fixture for the existing Ethereum Sticky release and real, migrated JBX.
/// @dev Does not call the historical fixture's local Sticky deployment or replace token/code/storage state.
abstract contract StickyJbxDeployedFork is StickyRealProjectFork {
    address internal constant _JBX = 0x4554CC10898f92D45378b98D6D6c2dD54c687Fb2;
    address internal constant _JBX_DONOR = 0x823b92d6a4b2AED4b15675c7917c9f922ea8ADAD;
    uint256 internal constant _JBX_ETHEREUM_BLOCK = 26_149_188;
    bytes32 internal constant _JBX_ETHEREUM_BLOCK_HASH =
        0xaddf5db4175ca8a6c92885cee2619e4012b867f8ff15ff42889de2de1b98784e;
    uint256 internal constant _ARBITRUM_RPC_CHAIN_ID = 42_161;
    bytes32 internal constant _JBX_RUNTIME_HASH = 0x575717dcd7f821c737de4e441be3cd1761cb58c622479d1d7f9d2f1b4821544b;

    /// @notice Selects the pinned live release; all ten manifest runtimes must match before any test writes.
    function _deployedJbxContext() internal returns (StickyRealProjectContext memory context) {
        context.forkId = _selectPinnedFork("ethereum", _JBX_ETHEREUM_BLOCK, 1, _JBX_ETHEREUM_BLOCK_HASH);
        string memory manifest = vm.readFile("deployments/ethereum/verified.json");
        assertEq(vm.parseJsonUint(manifest, ".chainId"), block.chainid, "deployment manifest chain");
        context.core = StickyCoreDeployment({
            controller: IJBController(_checkedAddress(manifest, "controller")),
            directory: IJBDirectory(_checkedAddress(manifest, "directory")),
            terminal: IJBMultiTerminal(_checkedAddress(manifest, "terminal"))
        });
        context.suite = StickyDeploymentAddresses({
            deployer: _checkedAddress(manifest, "deployer"),
            hook: _checkedAddress(manifest, "hook"),
            distributor: _checkedAddress(manifest, "distributor"),
            rewardReceiver: _checkedAddress(manifest, "rewardReceiver"),
            rewardReceiverFactory: _checkedAddress(manifest, "rewardReceiverFactory"),
            autoStick: _checkedAddress(manifest, "autoStick")
        });
        _checkedAddress(manifest, "create2Factory");
        StickyDeployer deployer = StickyDeployer(context.suite.deployer);
        StickyHook hook = StickyHook(context.suite.hook);
        StickyAutoStick adapter = StickyAutoStick(context.suite.autoStick);
        StickyRewardReceiverFactory receiverFactory = StickyRewardReceiverFactory(context.suite.rewardReceiverFactory);
        assertEq(address(deployer.CONTROLLER()), address(context.core.controller), "deployer controller");
        assertEq(address(deployer.TERMINAL()), address(context.core.terminal), "deployer terminal");
        assertEq(address(deployer.HOOK()), address(hook), "deployer hook");
        assertEq(address(deployer.TOKENS()), address(context.core.controller.TOKENS()), "deployer tokens");
        assertEq(address(context.core.controller.DIRECTORY()), address(context.core.directory), "controller directory");
        assertEq(address(hook.DIRECTORY()), address(context.core.directory), "hook directory");
        assertEq(hook.DEPLOYER(), address(deployer), "hook deployer");
        assertEq(address(adapter.DEPLOYER()), address(deployer), "adapter deployer");
        assertEq(address(adapter.DISTRIBUTOR()), context.suite.distributor, "adapter distributor");
        assertEq(address(adapter.HOOK()), address(hook), "adapter hook");
        assertEq(address(adapter.TERMINAL()), address(context.core.terminal), "adapter terminal");
        assertEq(address(adapter.TOKENS()), address(deployer.TOKENS()), "adapter tokens");
        assertEq(address(receiverFactory.DISTRIBUTOR()), context.suite.distributor, "receiver distributor");
        assertEq(address(receiverFactory.RECEIVER()), context.suite.rewardReceiver, "receiver implementation");
        assertEq(_JBX.codehash, _JBX_RUNTIME_HASH, "actual JBX runtime identity");
        context.underlying = IERC20Metadata(_JBX);
        assertEq(context.underlying.name(), "Juicebox", "canonical JBX name");
        assertEq(context.underlying.symbol(), "JBX", "canonical JBX symbol");
        assertEq(context.underlying.decimals(), 18, "canonical JBX decimals");
    }

    /// @notice Launches through the real deployed factory with the same sole AutoStick granter as the web client.
    function _launchDeployedJbx(
        StickyRealProjectContext memory context,
        uint256 tax,
        bool soulbound
    )
        internal
        returns (uint256 projectId, StickyToken token)
    {
        address[] memory granters = new address[](1);
        granters[0] = context.suite.autoStick;
        uint256 fee = context.core.controller.PROJECTS().creationFee();
        vm.deal(address(this), address(this).balance + fee);
        projectId = StickyDeployer(context.suite.deployer).deployStickyFor{value: fee}({
            stakedToken: context.underlying,
            name: "Sticky JBX",
            symbol: "STICKYJBX",
            projectUri: "data:application/json,%7B%22qualification%22%3A%22fork-only%22%7D",
            cashOutTaxRate: tax,
            granters: granters,
            soulbound: soulbound
        });
        token = StickyToken(address(context.core.controller.TOKENS().tokenOf(projectId)));
    }

    /// @notice Pins chain and canonical block hash, rather than accepting a same-height replacement block.
    function _selectPinnedFork(
        string memory rpcAlias,
        uint256 forkBlock,
        uint256 chainId,
        bytes32 expectedHash
    )
        internal
        returns (uint256 forkId)
    {
        forkId = vm.createSelectFork({urlOrAlias: rpcAlias, blockNumber: forkBlock});
        assertEq(block.chainid, chainId, "fork chain identity");
        string memory byHash =
            vm.rpcJson("eth_getBlockByHash", string.concat('["', vm.toString(expectedHash), '",false]'));
        string memory number = vm.parseJsonString(byHash, ".number");
        assertEq(vm.parseUint(number), forkBlock, "pinned hash block height");
        string memory canonical = vm.rpcJson("eth_getBlockByNumber", string.concat('["', number, '",false]'));
        assertEq(vm.parseJsonBytes32(canonical, ".hash"), expectedHash, "canonical pinned block hash");
        bytes32 parentHash = vm.parseJsonBytes32(canonical, ".parentHash");
        if (chainId == _ARBITRUM_RPC_CHAIN_ID) {
            // Foundry already models Arbitrum's L1-style NUMBER opcode. RPC height remains the Nitro block number.
            // The pinned canonical hash binds both fields; do not roll the fork to a synthetic EVM height.
            uint256 evmBlockNumber = vm.parseUint(vm.parseJsonString(canonical, ".l1BlockNumber"));
            assertEq(block.number, evmBlockNumber, "Arbitrum EVM L1 block number");
            // BLOCKHASH accepts EVM L1-style numbers here, not Nitro RPC heights. Validate the RPC parent header
            // directly rather than confusing these two independent block-number domains.
            string memory parent =
                vm.rpcJson("eth_getBlockByHash", string.concat('["', vm.toString(parentHash), '",false]'));
            assertEq(vm.parseJsonBytes32(parent, ".hash"), parentHash, "Arbitrum RPC parent hash");
            assertEq(vm.parseUint(vm.parseJsonString(parent, ".number")), forkBlock - 1, "Arbitrum RPC parent height");
        } else {
            assertEq(block.number, forkBlock, "fork EVM and RPC block height");
            assertEq(blockhash(forkBlock - 1), parentHash, "fork parent identity");
        }
    }

    /// @notice Moves actual holder inventory on the local fork and proves both wallet deltas and supply conservation.
    function _transferJbx(address beneficiary, uint256 amount) internal {
        IERC20Metadata token = IERC20Metadata(_JBX);
        uint256 donorBefore = token.balanceOf(_JBX_DONOR);
        uint256 recipientBefore = token.balanceOf(beneficiary);
        uint256 supplyBefore = token.totalSupply();
        assertGe(donorBefore, amount, "real JBX donor must hold enough tokens at the pinned block");
        vm.prank(_JBX_DONOR);
        assertTrue(token.transfer(beneficiary, amount), "real holder JBX transfer");
        assertEq(token.balanceOf(_JBX_DONOR), donorBefore - amount, "donor inventory debit");
        assertEq(token.balanceOf(beneficiary), recipientBefore + amount, "recipient actual JBX credit");
        assertEq(token.totalSupply(), supplyBefore, "no synthetic JBX issuance");
    }

    function _checkedAddress(string memory manifest, string memory key) private view returns (address target) {
        target = vm.parseJsonAddress(manifest, string.concat(".", key));
        assertGt(target.code.length, 0, string.concat(key, " must already be deployed"));
        assertEq(target.codehash, vm.parseJsonBytes32(manifest, string.concat(".", key, "Codehash")), key);
    }
}

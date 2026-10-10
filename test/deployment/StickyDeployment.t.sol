// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBaseWorkflow} from "@bananapus/core-v6/test/helpers/TestBaseWorkflow.sol";
import {JBSuckerRegistry} from "@bananapus/suckers-v6/src/JBSuckerRegistry.sol";

import {StickyDeployment} from "../../script/helpers/StickyDeployment.sol";
import {MockArt} from "../../script/mocks/MockArt.sol";
import {StickyDeployer} from "../../src/StickyDeployer.sol";
import {StickyDistributor} from "../../src/StickyDistributor.sol";
import {StickyHook} from "../../src/StickyHook.sol";
import {StickyPriceFeed} from "../../src/StickyPriceFeed.sol";
import {StickySourceCollector} from "../../src/StickySourceCollector.sol";
import {StickySourceFeePayer} from "../../src/StickySourceFeePayer.sol";
import {StickyToken} from "../../src/StickyToken.sol";

import {StickyCoreDeployment} from "../../script/structs/StickyCoreDeployment.sol";
import {StickyDeploymentAddresses} from "../../script/structs/StickyDeploymentAddresses.sol";
import {StickyImmutableReference} from "../../script/structs/StickyImmutableReference.sol";

import {StickyDeploymentHarness} from "./StickyDeploymentHarness.sol";

/// @notice Tests the production deployment helper against real core contracts, without live network writes.
contract StickyDeploymentTest is TestBaseWorkflow {
    //*********************************************************************//
    // -------------------- internal stored properties ------------------- //
    //*********************************************************************//

    /// @notice The local V6 core contracts the deployment binds to.
    StickyCoreDeployment internal _core;

    /// @notice The production deployment helper under test.
    StickyDeploymentHarness internal _deployment;

    //*********************************************************************//
    // -------------------------- public views --------------------------- //
    //*********************************************************************//

    function test_allNetworkFoldersMatchCurrentCoreLayout() public view {
        assertEq(_deployment.network(1), "ethereum");
        // forge-lint: disable-next-line(literal-instead-of-constant)
        assertEq(_deployment.network(10), "optimism");
        // forge-lint: disable-next-line(literal-instead-of-constant)
        assertEq(_deployment.network(8453), "base");
        // forge-lint: disable-next-line(literal-instead-of-constant)
        assertEq(_deployment.network(42_161), "arbitrum");
        // forge-lint: disable-next-line(literal-instead-of-constant)
        assertEq(_deployment.network(11_155_111), "sepolia");
        // forge-lint: disable-next-line(literal-instead-of-constant)
        assertEq(_deployment.network(11_155_420), "optimism_sepolia");
        // forge-lint: disable-next-line(literal-instead-of-constant)
        assertEq(_deployment.network(84_532), "base_sepolia");
        // forge-lint: disable-next-line(literal-instead-of-constant)
        assertEq(_deployment.network(421_614), "arbitrum_sepolia");
    }

    //*********************************************************************//
    // ----------------------- public transactions ----------------------- //
    //*********************************************************************//

    function setUp() public override {
        super.setUp();
        vm.chainId(1);
        vm.warp(1_800_000_000);
        _deployment = new StickyDeploymentHarness();
        _core = StickyCoreDeployment({
            controller: jbController(),
            directory: jbDirectory(),
            registry: new JBSuckerRegistry({
                directory: jbDirectory(),
                permissions: jbPermissions(),
                prices: jbPrices(),
                initialOwner: address(this),
                trustedForwarder: trustedForwarder()
            }),
            terminal: jbMultiTerminal()
        });
        vm.etch(
            _deployment.DETERMINISTIC_FACTORY(),
            hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3"
        );
        // Stand in for the core forwarder contract, which verification requires to have code.
        // forge-lint: disable-next-line(literal-instead-of-constant)
        vm.etch(trustedForwarder(), hex"00");
    }

    function test_cleanDeploymentAndRepeatPreserveEveryAddressAndOriginalTimestamp() public {
        StickyDeploymentAddresses memory predicted = _deployment.predict({core: _core, destinationChainId: 1});
        assertEq(predicted.deployer.code.length, 0);
        StickyDeploymentAddresses memory first = _deployment.deployFor({core: _core, destinationChainId: 1});
        assertEq(keccak256(abi.encode(first)), keccak256(abi.encode(predicted)));
        bytes32 firstHash = first.distributor.codehash;
        uint256 firstTimestamp = StickyDistributor(payable(first.distributor)).STARTING_TIMESTAMP();
        vm.warp(block.timestamp + 10 days);
        vm.recordLogs();
        StickyDeploymentAddresses memory second = _deployment.deployFor({core: _core, destinationChainId: 1});
        assertEq(vm.getRecordedLogs().length, 0, "repeat creates no contracts or transactions with logs");
        assertEq(keccak256(abi.encode(first)), keccak256(abi.encode(second)));
        assertEq(second.distributor.codehash, firstHash);
        assertEq(StickyDistributor(payable(second.distributor)).STARTING_TIMESTAMP(), firstTimestamp);
        _deployment.verify(_core, second);
    }

    function test_deployedFactoryLaunchesTokenWithCanonicalHookAndRegistryBindings() public {
        StickyDeploymentAddresses memory deployed = _deployment.deployFor({core: _core, destinationChainId: 1});
        StickyDeployer factory = StickyDeployer(deployed.deployer);
        MockArt underlying = new MockArt();
        uint256 fee = jbProjects().creationFee();
        vm.deal(address(this), fee);
        address[] memory granters = new address[](1);
        granters[0] = deployed.autoStick;
        // forge-lint: disable-next-item(arbitrary-send-eth)
        uint256 projectId = factory.deployStickyFor{value: fee}({
            stakedToken: underlying,
            name: "Deployment rehearsal",
            symbol: "STICKY",
            projectUri: "ipfs://deployment-rehearsal",
            cashOutTaxRate: 0,
            granters: granters,
            soulbound: true
        });
        StickyToken token = StickyToken(address(jbTokens().tokenOf(projectId)));
        assertEq(jbProjects().ownerOf(projectId), deployed.deployer);
        assertEq(address(token.HOOK()), deployed.hook);
        assertEq(address(token.TOKENS()), address(jbTokens()));
        assertEq(token.PROJECT_ID(), projectId);
        assertTrue(token.SOULBOUND());
        assertEq(factory.HOOK().tokenOf(projectId), address(token));
        assertEq(address(factory.stakedTokenOf(projectId)), address(underlying));
        StickyPriceFeed feed = StickyPriceFeed(address(factory.priceFeedOf(projectId)));
        assertGt(address(feed).code.length, 0);
        assertEq(address(feed.HOOK()), deployed.hook);
        assertEq(address(feed.TOKEN()), address(token));
        assertEq(address(feed.TERMINAL()), address(_core.terminal));
        assertEq(feed.PROJECT_ID(), projectId);
        assertEq(feed.UNDERLYING_TOKEN(), address(underlying));
        assertEq(feed.DECIMALS(), 18);
        _deployment.verify(_core, deployed);
    }

    /// @notice Different homes reuse the six deployed singletons while creating independent bound source families.
    function test_destinationFamiliesCoexistWithoutChangingSharedSingletons() public {
        StickyDeploymentAddresses memory ethereum = _deployment.deployFor({core: _core, destinationChainId: 1});
        bytes32 sourceHash = ethereum.sourceCollector.codehash;
        bytes32 childHash = ethereum.sourceFeePayer.codehash;
        StickyDeploymentAddresses memory base = _deployment.deployFor({core: _core, destinationChainId: 8453});
        assertEq(base.deployer, ethereum.deployer);
        assertEq(base.hook, ethereum.hook);
        assertEq(base.distributor, ethereum.distributor);
        assertEq(base.rewardReceiver, ethereum.rewardReceiver);
        assertEq(base.rewardReceiverFactory, ethereum.rewardReceiverFactory);
        assertEq(base.autoStick, ethereum.autoStick);
        assertNotEq(base.sourceCollector, ethereum.sourceCollector);
        assertNotEq(base.sourceFeePayer, ethereum.sourceFeePayer);
        assertEq(StickySourceCollector(ethereum.sourceCollector).DESTINATION_CHAIN_ID(), 1);
        assertEq(StickySourceCollector(base.sourceCollector).DESTINATION_CHAIN_ID(), 8453);
        assertEq(ethereum.sourceCollector.codehash, sourceHash);
        assertEq(ethereum.sourceFeePayer.codehash, childHash);
        _deployment.verify({core: _core, deployed: ethereum});
        _deployment.verify({core: _core, deployed: base});
    }

    /// @notice The shared production operation deploys the exact four homes with one shared singleton suite.
    function test_deployAllCoversEveryHomeInCanonicalOrder() public {
        StickyDeploymentAddresses[4] memory deployed = _deployment.deployAllFor(_core);
        uint256[4] memory expected = _deployment.destinationChainIds();
        for (uint256 i; i < deployed.length; i++) {
            assertEq(deployed[i].destinationChainId, expected[i]);
            assertEq(deployed[i].deployer, deployed[0].deployer);
            assertEq(deployed[i].hook, deployed[0].hook);
            assertEq(deployed[i].distributor, deployed[0].distributor);
            assertEq(deployed[i].rewardReceiver, deployed[0].rewardReceiver);
            assertEq(deployed[i].rewardReceiverFactory, deployed[0].rewardReceiverFactory);
            assertEq(deployed[i].autoStick, deployed[0].autoStick);
            for (uint256 j; j < i; j++) {
                assertNotEq(deployed[i].sourceCollector, deployed[j].sourceCollector);
                assertNotEq(deployed[i].sourceFeePayer, deployed[j].sourceFeePayer);
            }
        }
    }

    function test_distributorBindsTheDeployedHookWithProductionPolicy() public {
        StickyDeploymentAddresses memory deployed = _deployment.deployFor({core: _core, destinationChainId: 1});
        StickyDistributor distributor = StickyDistributor(payable(deployed.distributor));
        assertEq(address(distributor.STICKY_HOOK()), deployed.hook);
        assertEq(distributor.EPOCH_DURATION(), StickyHook(deployed.hook).EPOCH_DURATION());
        // forge-lint: disable-next-line(literal-instead-of-constant)
        assertEq(distributor.EPOCH_DURATION(), 1 weeks);
        assertEq(address(distributor.CONTROLLER()), address(_core.controller));
        assertEq(address(distributor.DIRECTORY()), address(_core.directory));
        assertEq(address(distributor.REV_LOANS()), address(0));
        assertEq(address(distributor.REV_OWNER()), address(0));
        // forge-lint: disable-next-line(literal-instead-of-constant)
        assertEq(distributor.ROUND_DURATION(), 7 days);
        // forge-lint: disable-next-line(literal-instead-of-constant)
        assertEq(distributor.VESTING_ROUNDS(), 4);
        // forge-lint: disable-next-line(literal-instead-of-constant)
        assertEq(distributor.CLAIM_DURATION(), 2 * 365 days);
        assertLe(deployed.distributor.code.length, 24_576);

        // A distributor bound to a different hook has identical opcodes and fails the binding check.
        StickyDeployer other = new StickyDeployer({controller: _core.controller, terminal: _core.terminal});
        StickyDistributor different = new StickyDistributor({
            controller: _core.controller,
            directory: _core.directory,
            stickyHook: other.HOOK(),
            // forge-lint: disable-next-line(literal-instead-of-constant)
            initialRoundDuration: 7 days,
            // forge-lint: disable-next-line(literal-instead-of-constant)
            initialVestingRounds: 4,
            // forge-lint: disable-next-line(literal-instead-of-constant)
            initialClaimDuration: uint48(2 * 365 days)
        });
        vm.etch(deployed.distributor, address(different).code);
        _deployment.verifyRuntime("StickyDistributor", deployed.distributor);
        vm.expectPartialRevert(StickyDeployment.StickyDeployment_BindingMismatch.selector);
        _deployment.verify(_core, deployed);
    }

    /// @notice Every supported source selects the complete ordered home set for its own environment.
    function test_destinationChainIdsFollowSourceEnvironment() public {
        uint256[4] memory mainnets = _deployment.destinationChainIds();
        uint256[4] memory expectedMainnets = [uint256(1), 10, 8453, 42_161];
        for (uint256 i; i < expectedMainnets.length; i++) {
            assertEq(mainnets[i], expectedMainnets[i]);
        }

        vm.chainId(84_532);
        uint256[4] memory testnets = _deployment.destinationChainIds();
        uint256[4] memory expectedTestnets = [uint256(11_155_111), 11_155_420, 84_532, 421_614];
        for (uint256 i; i < expectedTestnets.length; i++) {
            assertEq(testnets[i], expectedTestnets[i]);
        }

        vm.chainId(999);
        vm.expectRevert(abi.encodeWithSelector(StickyDeployment.StickyDeployment_UnsupportedChain.selector, 999));
        // forge-lint: disable-next-line(unused-return)
        _deployment.destinationChainIds();
    }

    function test_loadsFlatCoreArtifactsWithoutForwarder() public {
        // forge-lint: disable-next-line(literal-instead-of-constant)
        vm.chainId(11_155_111);
        // forge-lint: disable-next-line(literal-instead-of-constant)
        string memory root = _writeCoreArtifacts(11_155_111);
        StickyCoreDeployment memory loaded = _deployment.loadCoreFrom({root: root, suckerRoot: root});
        assertEq(address(loaded.controller), address(_core.controller));
        assertEq(address(loaded.terminal), address(_core.terminal));
        assertEq(address(loaded.registry), address(_core.registry));
    }

    /// @notice A second family writes its own verified identity without overwriting another family's record.
    function test_manifestDestinationFamiliesDoNotOverwriteEachOther() public {
        StickyDeploymentAddresses memory ethereum = _deployment.deployFor({core: _core, destinationChainId: 1});
        StickyDeploymentAddresses memory base = _deployment.deployFor({core: _core, destinationChainId: 8453});
        string memory canonical = vm.readFile("deployments/ethereum/verified.json");
        _deployment.writeManifest({core: _core, deployed: ethereum});
        string memory first = vm.readFile("deployments/ethereum/source-collectors/1/test.json");
        _deployment.writeManifest({core: _core, deployed: base});
        string memory second = vm.readFile("deployments/ethereum/source-collectors/8453/test.json");
        assertEq(vm.readFile("deployments/ethereum/source-collectors/1/test.json"), first);
        assertEq(vm.readFile("deployments/ethereum/verified.json"), canonical);
        assertEq(vm.parseJsonUint({json: first, key: ".destinationChainId"}), 1);
        assertEq(vm.parseJsonUint({json: second, key: ".destinationChainId"}), 8453);
        assertEq(vm.parseJsonAddress({json: first, key: ".sourceCollector"}), ethereum.sourceCollector);
        assertEq(vm.parseJsonAddress({json: second, key: ".sourceCollector"}), base.sourceCollector);
    }

    function test_manifestDistinguishesRpcBlockFromEvmHeight() public {
        // forge-lint: disable-next-line(literal-instead-of-constant)
        vm.chainId(42_161);
        // forge-lint: disable-next-line(literal-instead-of-constant)
        vm.roll(42);
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("STICKY_RPC_BLOCK_NUMBER", "100");
        bytes32 rpcBlockHash = keccak256("canonical RPC block");
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("STICKY_RPC_BLOCK_HASH", vm.toString(rpcBlockHash));
        StickyDeploymentAddresses memory deployed = _deployment.deployFor({core: _core, destinationChainId: 1});
        _deployment.writeManifest(_core, deployed);
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = vm.readFile("deployments/arbitrum/source-collectors/1/test.json");
        // forge-lint: disable-next-line(literal-instead-of-constant)
        assertEq(vm.parseJsonUint(json, ".evmBlockNumber"), 42);
        assertEq(vm.parseJsonUint(json, ".rpcBlockNumber"), 100);
        assertEq(vm.parseJsonBytes32(json, ".rpcBlockHash"), rpcBlockHash);
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("STICKY_RPC_BLOCK_NUMBER", "0");
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("STICKY_RPC_BLOCK_HASH", vm.toString(bytes32(0)));
    }

    function test_partialDeploymentResumesWithoutReplacingFactoryOrHook() public {
        _deployment.deployDeployerOnly(_core);
        StickyDeploymentAddresses memory predicted = _deployment.predict({core: _core, destinationChainId: 1});
        bytes32 deployerHash = predicted.deployer.codehash;
        bytes32 hookHash = predicted.hook.codehash;
        assertGt(predicted.deployer.code.length, 0);
        assertEq(predicted.distributor.code.length, 0);
        StickyDeploymentAddresses memory resumed = _deployment.deployFor({core: _core, destinationChainId: 1});
        assertEq(resumed.deployer.codehash, deployerHash);
        assertEq(resumed.hook.codehash, hookHash);
        _deployment.verify(_core, resumed);
    }

    function test_rejectsConsistentlyWrongImmutableDependency() public {
        StickyDeploymentAddresses memory deployed = _deployment.deployFor({core: _core, destinationChainId: 1});
        // A legitimate second factory has identical opcodes and different constructor-created HOOK references.
        StickyDeployer different = new StickyDeployer({controller: _core.controller, terminal: _core.terminal});
        vm.etch(deployed.deployer, address(different).code);
        _deployment.verifyRuntime("StickyDeployer", deployed.deployer);
        vm.expectPartialRevert(StickyDeployment.StickyDeployment_BindingMismatch.selector);
        // forge-lint: disable-next-line(unused-return)
        _deployment.deployFor({core: _core, destinationChainId: 1});
    }

    function test_rejectsConsistentlyWrongSourceCollectorBinding() public {
        StickyDeploymentAddresses memory deployed = _deployment.deployFor({core: _core, destinationChainId: 1});
        StickySourceCollector different = new StickySourceCollector({
            registry: _core.registry,
            tokens: _core.controller.TOKENS(),
            receiverFactory: StickySourceCollector(deployed.sourceCollector).RECEIVER_FACTORY(),
            destinationChainId: deployed.destinationChainId
        });
        vm.etch(deployed.sourceCollector, address(different).code);
        _deployment.verifyRuntime({name: "StickySourceCollector", target: deployed.sourceCollector});
        vm.expectPartialRevert(StickyDeployment.StickyDeployment_BindingMismatch.selector);
        _deployment.verify({core: _core, deployed: deployed});
    }

    function test_rejectsConsistentlyWrongSourceFeePayerBinding() public {
        StickyDeploymentAddresses memory deployed = _deployment.deployFor({core: _core, destinationChainId: 1});
        StickySourceFeePayer different = new StickySourceFeePayer();
        vm.etch(deployed.sourceFeePayer, address(different).code);
        _deployment.verifyRuntime({name: "StickySourceFeePayer", target: deployed.sourceFeePayer});
        vm.expectPartialRevert(StickyDeployment.StickyDeployment_BindingMismatch.selector);
        _deployment.verify({core: _core, deployed: deployed});
    }

    function test_rejectsControllerWithoutProjectLaunchAuthorization() public {
        vm.mockCall(
            address(_core.directory),
            abi.encodeWithSignature("isAllowedToSetFirstController(address)", address(_core.controller)),
            abi.encode(false)
        );
        vm.expectPartialRevert(StickyDeployment.StickyDeployment_BindingMismatch.selector);
        // forge-lint: disable-next-line(unused-return)
        _deployment.deployFor({core: _core, destinationChainId: 1});
    }

    function test_rejectsDifferentCorePriceRegistriesBeforeAnyDeployment() public {
        // forge-lint: disable-next-line(literal-instead-of-constant)
        vm.mockCall(address(_core.terminal.STORE()), abi.encodeWithSignature("PRICES()"), abi.encode(address(0xdead)));
        vm.expectPartialRevert(StickyDeployment.StickyDeployment_BindingMismatch.selector);
        // forge-lint: disable-next-line(unused-return)
        _deployment.deployFor({core: _core, destinationChainId: 1});
    }

    function test_rejectsDifferentCoreRulesetRegistries() public {
        // forge-lint: disable-next-line(literal-instead-of-constant)
        vm.mockCall(address(_core.terminal.STORE()), abi.encodeWithSignature("RULESETS()"), abi.encode(address(0xdead)));
        vm.expectPartialRevert(StickyDeployment.StickyDeployment_BindingMismatch.selector);
        // forge-lint: disable-next-line(unused-return)
        _deployment.deployFor({core: _core, destinationChainId: 1});
    }

    /// @notice A record cannot combine one family's destination with another family's deployed source contracts.
    function test_rejectsFamilyMixedDeploymentRecord() public {
        StickyDeploymentAddresses memory deployed = _deployment.deployFor({core: _core, destinationChainId: 1});
        deployed.destinationChainId = 8453;
        vm.expectRevert(
            abi.encodeWithSelector(
                StickyDeployment.StickyDeployment_BindingMismatch.selector, deployed.deployer, "CREATE2 predictions"
            )
        );
        _deployment.verify({core: _core, deployed: deployed});
    }

    function test_rejectsMismatchedExistingOpcode() public {
        StickyDeploymentAddresses memory deployed = _deployment.deployFor({core: _core, destinationChainId: 1});
        bytes memory code = deployed.deployer.code;
        code[0] = bytes1(uint8(code[0]) ^ 1);
        vm.etch(deployed.deployer, code);
        vm.expectPartialRevert(StickyDeployment.StickyDeployment_RuntimeMismatch.selector);
        // forge-lint: disable-next-line(unused-return)
        _deployment.deployFor({core: _core, destinationChainId: 1});
    }

    function test_rejectsMissingCoreCodeBeforeAnyDeployment() public {
        vm.etch(address(_core.terminal), hex"");
        vm.expectPartialRevert(StickyDeployment.StickyDeployment_MissingCode.selector);
        // forge-lint: disable-next-line(unused-return)
        _deployment.deployFor({core: _core, destinationChainId: 1});
    }

    function test_rejectsNoncanonicalUpperBitsInImmutableAddress() public {
        StickyDeploymentAddresses memory deployed = _deployment.deployFor({core: _core, destinationChainId: 1});
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = vm.readFile("out/StickyDeployer.sol/StickyDeployer.json");
        string memory root = ".deployedBytecode.immutableReferences";
        string[] memory keys = vm.parseJsonKeys(json, root);
        StickyImmutableReference[] memory refs =
            abi.decode(vm.parseJson(json, string.concat(root, ".", keys[0])), (StickyImmutableReference[]));
        bytes memory code = deployed.deployer.code;
        // forge-lint: disable-next-line(uninitialized-local)
        for (uint256 i; i < refs.length; i++) {
            code[refs[i].start] = 0x01;
        }
        vm.etch(deployed.deployer, code);
        vm.expectPartialRevert(StickyDeployment.StickyDeployment_RuntimeMismatch.selector);
        _deployment.verifyRuntime("StickyDeployer", deployed.deployer);
    }

    function test_rejectsOneInconsistentImmutableOccurrence() public {
        StickyDeploymentAddresses memory deployed = _deployment.deployFor({core: _core, destinationChainId: 1});
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = vm.readFile("out/StickyDeployer.sol/StickyDeployer.json");
        string memory root = ".deployedBytecode.immutableReferences";
        string[] memory keys = vm.parseJsonKeys(json, root);
        bool mutated;
        // forge-lint: disable-next-line(uninitialized-local)
        for (uint256 i; i < keys.length; i++) {
            StickyImmutableReference[] memory refs =
            // forge-lint: disable-next-line(calls-loop)
            abi.decode(vm.parseJson(json, string.concat(root, ".", keys[i])), (StickyImmutableReference[]));
            if (refs.length < 2) continue;
            bytes memory code = deployed.deployer.code;
            // forge-lint: disable-next-line(literal-instead-of-constant)
            code[refs[1].start + 31] = bytes1(uint8(code[refs[1].start + 31]) ^ 1);
            // forge-lint: disable-next-line(calls-loop)
            vm.etch(deployed.deployer, code);
            mutated = true;
            break;
        }
        // forge-lint: disable-next-line(uninitialized-local)
        assertTrue(mutated, "fixture must modify a repeated immutable");
        vm.expectPartialRevert(StickyDeployment.StickyDeployment_RuntimeMismatch.selector);
        _deployment.verifyRuntime("StickyDeployer", deployed.deployer);
    }

    function test_rejectsUnsupportedChain() public {
        vm.expectPartialRevert(StickyDeployment.StickyDeployment_UnsupportedChain.selector);
        // forge-lint: disable-next-line(unused-return)
        _deployment.network(31_337);
    }

    function test_rejectsWrongCanonicalFactoryRuntime() public {
        // forge-lint: disable-next-line(literal-instead-of-constant)
        vm.etch(_deployment.DETERMINISTIC_FACTORY(), hex"00");
        vm.expectPartialRevert(StickyDeployment.StickyDeployment_RuntimeMismatch.selector);
        // forge-lint: disable-next-line(unused-return)
        _deployment.deployFor({core: _core, destinationChainId: 1});
    }

    /// @notice Runtime verification must compare the destination getter as well as every dependency address.
    function test_rejectsWrongCollectorDestinationBinding() public {
        StickyDeploymentAddresses memory deployed = _deployment.deployFor({core: _core, destinationChainId: 1});
        vm.mockCall({
            callee: deployed.sourceCollector,
            data: abi.encodeWithSignature("DESTINATION_CHAIN_ID()"),
            returnData: abi.encode(uint256(8453))
        });
        vm.expectRevert(
            abi.encodeWithSelector(
                StickyDeployment.StickyDeployment_BindingMismatch.selector,
                deployed.sourceCollector,
                "source reward dependencies"
            )
        );
        _deployment.verify({core: _core, deployed: deployed});
    }

    function test_rejectsWrongCoreArtifactChain() public {
        // forge-lint: disable-next-line(literal-instead-of-constant)
        vm.chainId(11_155_111);
        string memory root = _writeCoreArtifacts(1);
        vm.expectPartialRevert(StickyDeployment.StickyDeployment_ChainMismatch.selector);
        // forge-lint: disable-next-line(unused-return)
        _deployment.loadCoreFrom({root: root, suckerRoot: root});
    }

    function test_rejectsWrongCoreBindingBeforeAnyDeployment() public {
        // forge-lint: disable-next-line(literal-instead-of-constant)
        vm.mockCall(address(_core.terminal), abi.encodeWithSignature("DIRECTORY()"), abi.encode(address(0xdead)));
        vm.expectPartialRevert(StickyDeployment.StickyDeployment_BindingMismatch.selector);
        // forge-lint: disable-next-line(unused-return)
        _deployment.deployFor({core: _core, destinationChainId: 1});
    }

    function test_rejectsWrongRegistryDirectoryBeforeAnyDeployment() public {
        vm.mockCall(address(_core.registry), abi.encodeWithSignature("DIRECTORY()"), abi.encode(address(0xdead)));
        vm.expectPartialRevert(StickyDeployment.StickyDeployment_BindingMismatch.selector);
        // forge-lint: disable-next-line(unused-return)
        _deployment.deployFor({core: _core, destinationChainId: 1});
    }

    function test_rejectsWrongRpcChainBeforeReadingArtifacts() public {
        // forge-lint: disable-next-line(literal-instead-of-constant)
        vm.chainId(10);
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("STICKY_EXPECTED_CHAIN_ID", "1");
        vm.expectRevert(
            abi.encodeWithSelector(
                // forge-lint: disable-next-line(literal-instead-of-constant)
                StickyDeployment.StickyDeployment_ChainMismatch.selector,
                "RPC",
                uint256(1),
                // forge-lint: disable-next-line(literal-instead-of-constant)
                uint256(10)
            )
        );
        // forge-lint: disable-next-line(unused-return)
        _deployment.loadCore("deployments/_missing");
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("STICKY_EXPECTED_CHAIN_ID", "0");
    }

    /// @notice Every selected family predicts one address across its source environment without changing shared
    /// singletons.
    function test_sameArtifactsAndCoreBindingsPredictSameAddressesOnEverySupportedChain() public {
        uint256[8] memory chainIds = [uint256(1), 10, 8453, 42_161, 11_155_111, 11_155_420, 84_532, 421_614];
        for (uint256 home; home < chainIds.length; home++) {
            vm.chainId(chainIds[home]);
            bytes32 expected =
                keccak256(abi.encode(_deployment.predict({core: _core, destinationChainId: chainIds[home]})));
            uint256 firstSource = home < 4 ? 0 : 4;
            for (uint256 source = firstSource; source < firstSource + 4; source++) {
                vm.chainId(chainIds[source]);
                assertEq(
                    keccak256(abi.encode(_deployment.predict({core: _core, destinationChainId: chainIds[home]}))),
                    expected
                );
            }
        }
    }

    /// @notice A prefunded nonce-1 child remains deployable and bound to its verified collector.
    function test_sourceCollectorBindsCanonicalDependenciesAndItsOnlyFeePayer() public {
        StickyDeploymentAddresses memory predicted = _deployment.predict({core: _core, destinationChainId: 1});
        vm.deal({account: predicted.sourceFeePayer, newBalance: 3 ether});
        StickyDeploymentAddresses memory deployed = _deployment.deployFor({core: _core, destinationChainId: 1});
        StickySourceCollector collector = StickySourceCollector(deployed.sourceCollector);
        assertEq(collector.DESTINATION_CHAIN_ID(), deployed.destinationChainId);
        assertEq(address(collector.REGISTRY()), address(_core.registry));
        assertEq(address(collector.TOKENS()), address(_core.controller.TOKENS()));
        assertEq(address(collector.DIRECTORY()), address(_core.directory));
        assertEq(address(collector.RECEIVER_FACTORY()), deployed.rewardReceiverFactory);
        assertEq(address(collector.FEE_PAYER()), deployed.sourceFeePayer);
        assertEq(StickySourceFeePayer(deployed.sourceFeePayer).COLLECTOR(), deployed.sourceCollector);
        assertEq(deployed.sourceFeePayer, vm.computeCreateAddress({deployer: deployed.sourceCollector, nonce: 1}));
        assertEq(deployed.sourceFeePayer.balance, 3 ether);
        assertEq(_deployment.STICKY_SALT(), bytes32("StickyDeployerV6"));
        assertEq(_deployment.AUTO_STICK_SALT(), bytes32("StickyAutoStickV6"));
        assertEq(_deployment.SOURCE_COLLECTOR_SALT(), bytes32("StickySourceCollectorV6"));
    }

    function test_verifiedManifestRecordsAllRuntimeHashes() public {
        // forge-lint: disable-next-line(literal-instead-of-constant)
        vm.chainId(11_155_111);
        StickyDeploymentAddresses memory deployed = _deployment.deployFor({core: _core, destinationChainId: 11_155_111});
        _deployment.writeManifest(_core, deployed);
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = vm.readFile("deployments/sepolia/source-collectors/11155111/test.json");
        assertEq(vm.parseJsonAddress(json, ".deployer"), deployed.deployer);
        assertEq(vm.parseJsonBytes32(json, ".hookCodehash"), deployed.hook.codehash);
        assertEq(vm.parseJsonBytes32(json, ".autoStickCodehash"), deployed.autoStick.codehash);
        assertEq(vm.parseJsonAddress(json, ".registry"), address(_core.registry));
        assertEq(vm.parseJsonAddress(json, ".tokens"), address(_core.controller.TOKENS()));
        assertEq(vm.parseJsonAddress(json, ".sourceCollector"), deployed.sourceCollector);
        assertEq(vm.parseJsonBytes32(json, ".sourceCollectorCodehash"), deployed.sourceCollector.codehash);
        assertEq(vm.parseJsonAddress(json, ".sourceFeePayer"), deployed.sourceFeePayer);
        assertEq(vm.parseJsonBytes32(json, ".sourceFeePayerCodehash"), deployed.sourceFeePayer.codehash);
        assertEq(vm.parseJsonBytes32(json, ".sourceCollectorSalt"), _deployment.SOURCE_COLLECTOR_SALT());
        // forge-lint: disable-next-line(literal-instead-of-constant)
        assertEq(vm.parseJsonUint(json, ".chainId"), 11_155_111);
        assertEq(vm.parseJsonString(json, ".kind"), "test");
        assertEq(vm.parseJsonUint(json, ".destinationChainId"), deployed.destinationChainId);
    }

    //*********************************************************************//
    // ---------------------- internal transactions ---------------------- //
    //*********************************************************************//

    /// @notice Writes one core artifact file in the flat sepolia layout under a test root.
    /// @param root The directory holding the test artifacts.
    /// @param name The core contract name used as the artifact file name.
    /// @param target The deployed address recorded in the artifact.
    /// @param chainId The chain ID recorded in the artifact.
    function _writeArtifact(string memory root, string memory name, address target, uint256 chainId) internal {
        string memory key = string.concat("artifact-", name);
        // forge-lint: disable-next-line(unused-return)
        vm.serializeAddress(key, "address", target);
        string memory json = vm.serializeString(key, "chainId", vm.toString(bytes32(chainId)));
        vm.writeJson(json, string.concat(root, "/sepolia/", name, ".json"));
    }

    /// @notice Writes the local core contracts as artifacts for a chain under a fresh test root.
    /// @param chainId The chain ID recorded in every artifact.
    /// @return root The directory holding the written artifacts.
    function _writeCoreArtifacts(uint256 chainId) internal returns (string memory root) {
        root = string.concat("deployments/_test/", vm.toString(chainId));
        vm.createDir(string.concat(root, "/sepolia"), true);
        _writeArtifact(root, "JBController", address(_core.controller), chainId);
        _writeArtifact(root, "JBDirectory", address(_core.directory), chainId);
        _writeArtifact(root, "JBMultiTerminal", address(_core.terminal), chainId);
        _writeArtifact({root: root, name: "JBSuckerRegistry", target: address(_core.registry), chainId: chainId});
    }
}

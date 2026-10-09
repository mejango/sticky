// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IJBDirectory} from "@bananapus/core-v6/src/interfaces/IJBDirectory.sol";
import {IJBPermissions} from "@bananapus/core-v6/src/interfaces/IJBPermissions.sol";
import {IJBTokens} from "@bananapus/core-v6/src/interfaces/IJBTokens.sol";
import {JBArbitrumSucker} from "@bananapus/suckers-v6/src/JBArbitrumSucker.sol";
import {JBArbitrumSuckerDeployer} from "@bananapus/suckers-v6/src/deployers/JBArbitrumSuckerDeployer.sol";
import {IJBSuckerRegistry} from "@bananapus/suckers-v6/src/interfaces/IJBSuckerRegistry.sol";
import {JBRemoteToken} from "@bananapus/suckers-v6/src/structs/JBRemoteToken.sol";

/// @notice Exposes the installed Arbitrum transport without reproducing its refund-recipient logic.
contract SourceFeeArbitrumHarness is JBArbitrumSucker {
    /// @notice Configures only the dependencies needed to exercise the installed transport.
    /// @param deployer The endpoint configuration fixture.
    /// @param directory The project directory fixture.
    /// @param tokens The token registry fixture.
    /// @param registry The fee registry fixture.
    constructor(
        JBArbitrumSuckerDeployer deployer,
        IJBDirectory directory,
        IJBTokens tokens,
        IJBSuckerRegistry registry
    )
        JBArbitrumSucker(deployer, directory, IJBPermissions(address(0)), tokens, 1, registry, address(0))
    {}

    /// @notice Returns a fixed nonzero transport destination.
    /// @return The peer address encoded for the sucker interface.
    function peer() public pure override returns (bytes32) {
        return bytes32(uint256(uint160(address(0xBEEF))));
    }

    /// @notice Executes the installed L1-to-L2 transport with the caller preserved.
    /// @param token The native sentinel or ERC-20 backing token.
    /// @param amount The backing amount included in this message.
    function transport(address token, uint256 amount) external payable {
        _toL2({
            token: token,
            transportPayment: msg.value,
            amount: amount,
            data: hex"1234",
            remoteToken: JBRemoteToken({
                enabled: true, emergencyHatch: false, minGas: 200_000, addr: bytes32(uint256(1))
            }),
            gasLimit: 200_000
        });
    }
}

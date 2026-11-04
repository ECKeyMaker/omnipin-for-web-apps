// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script} from "forge-std/Script.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {SponsorPaymaster} from "../src/SponsorPaymaster.sol";

/// Deploys the public treasury (a timelock the multisig controls) and the
/// paymaster it owns. Needs MULTISIG, GATEWAY_SIGNER, TIMELOCK_DELAY (seconds)
/// and MAX_COST_PER_OP (wei). The paymaster still has to be staked and funded.
contract Deploy is Script {
    /// EntryPoint v0.7, at the same address on every chain it's deployed to.
    address constant ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    function run() external returns (TimelockController treasury, SponsorPaymaster paymaster) {
        address multisig = vm.envAddress("MULTISIG");
        address[] memory admins = new address[](1);
        admins[0] = multisig;

        vm.startBroadcast();
        treasury = new TimelockController(vm.envUint("TIMELOCK_DELAY"), admins, admins, address(0));
        paymaster = new SponsorPaymaster(
            IEntryPoint(ENTRY_POINT),
            address(treasury),
            vm.envAddress("GATEWAY_SIGNER"),
            vm.envUint("MAX_COST_PER_OP")
        );
        vm.stopBroadcast();
    }
}

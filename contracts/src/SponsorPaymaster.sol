// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {BasePaymaster} from "@account-abstraction/contracts/core/BasePaymaster.sol";
import {UserOperationLib} from "@account-abstraction/contracts/core/UserOperationLib.sol";
import {_packValidationData} from "@account-abstraction/contracts/core/Helpers.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title Sponsor paymaster
/// @notice Pays gas from a publicly funded EntryPoint deposit, for operations
/// the funding gateway approved. Anyone can fund it with
/// `EntryPoint.depositTo(paymaster)`; only the owner can withdraw.
/// @dev Deliberately small, since it guards public money:
/// - `signer` and `maxCostPerOp` are immutable, so a leaked signer can't change
///   the rules, and validation reads no storage, which keeps it inside the
///   bundlers' ERC-7562 rules. To rotate, deploy a new paymaster.
/// - The gateway decides what's worth sponsoring. This contract only enforces
///   the worst case: a signer that leaks can spend at most `maxCostPerOp` per
///   operation, and at most the deposit, so keep the deposit small.
/// - No `postOp`, so no ERC-20 logic or refund accounting to get wrong.
contract SponsorPaymaster is BasePaymaster {
    using UserOperationLib for PackedUserOperation;

    /// @dev `paymasterAndData`: paymaster (20), verification gas (16),
    /// post-op gas (16), then validUntil (6), validAfter (6), signature (65).
    uint256 private constant TIMESTAMPS_OFFSET = 52;
    uint256 private constant SIGNATURE_OFFSET = 64;
    uint256 private constant SIGNATURE_LENGTH = 65;

    /// @notice Gateway key that approves operations. It can't move funds.
    address public immutable signer;

    /// @notice Most wei a single operation can cost this paymaster.
    uint256 public immutable maxCostPerOp;

    error InvalidPaymasterData();
    error CostAboveCap(uint256 maxCost, uint256 cap);
    error ZeroAddress();

    constructor(IEntryPoint entryPoint_, address owner_, address signer_, uint256 maxCostPerOp_)
        BasePaymaster(entryPoint_)
    {
        if (owner_ == address(0) || signer_ == address(0)) revert ZeroAddress();
        signer = signer_;
        maxCostPerOp = maxCostPerOp_;
        _transferOwnership(owner_);
    }

    /// @notice Digest the gateway signs. It binds the whole operation except
    /// its signature, plus this contract and chain, so an approval can't be
    /// replayed elsewhere or attached to a changed operation.
    function getHash(PackedUserOperation calldata userOp, uint48 validUntil, uint48 validAfter)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                userOp.sender,
                userOp.nonce,
                keccak256(userOp.initCode),
                keccak256(userOp.callData),
                userOp.accountGasLimits,
                keccak256(userOp.paymasterAndData[:TIMESTAMPS_OFFSET]),
                userOp.preVerificationGas,
                userOp.gasFees,
                block.chainid,
                address(this),
                validUntil,
                validAfter
            )
        );
    }

    /// @dev Signature failures return `SIG_VALIDATION_FAILED` rather than
    /// reverting, as ERC-4337 expects. Malformed data does revert.
    function _validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256 maxCost)
        internal
        view
        override
        returns (bytes memory context, uint256 validationData)
    {
        if (maxCost > maxCostPerOp) revert CostAboveCap(maxCost, maxCostPerOp);

        bytes calldata data = userOp.paymasterAndData;
        if (data.length != SIGNATURE_OFFSET + SIGNATURE_LENGTH) revert InvalidPaymasterData();

        uint48 validUntil = uint48(bytes6(data[TIMESTAMPS_OFFSET:TIMESTAMPS_OFFSET + 6]));
        uint48 validAfter = uint48(bytes6(data[TIMESTAMPS_OFFSET + 6:SIGNATURE_OFFSET]));

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(getHash(userOp, validUntil, validAfter));
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(digest, data[SIGNATURE_OFFSET:]);
        bool failed = error != ECDSA.RecoverError.NoError || recovered != signer;

        return ("", _packValidationData(failed, validUntil, validAfter));
    }
}

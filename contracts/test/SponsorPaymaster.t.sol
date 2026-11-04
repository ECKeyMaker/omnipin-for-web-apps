// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {EntryPoint} from "@account-abstraction/contracts/core/EntryPoint.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {SimpleAccount} from "@account-abstraction/contracts/samples/SimpleAccount.sol";
import {SimpleAccountFactory} from "@account-abstraction/contracts/samples/SimpleAccountFactory.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {SponsorPaymaster} from "../src/SponsorPaymaster.sol";

contract Resolver {
    mapping(bytes32 => bytes) public contenthash;

    function setContenthash(bytes32 node, bytes calldata hash) external {
        contenthash[node] = hash;
    }
}

contract SponsorPaymasterTest is Test {
    uint256 constant MAX_COST = 0.05 ether;
    uint256 constant DELAY = 2 days;
    bytes32 constant NODE = keccak256("site.eth");

    EntryPoint entryPoint;
    SponsorPaymaster paymaster;
    TimelockController timelock;
    SimpleAccount account;
    Resolver resolver;

    address multisig = makeAddr("multisig");
    address beneficiary = makeAddr("beneficiary");
    address bundler = makeAddr("bundler");
    address donor = makeAddr("donor");
    uint256 ownerKey = 0xA11CE;
    uint256 signerKey = 0x516E4;

    function setUp() public {
        vm.warp(1_700_000_000);
        entryPoint = new EntryPoint();

        address[] memory admins = new address[](1);
        admins[0] = multisig;
        timelock = new TimelockController(DELAY, admins, admins, address(0));

        paymaster = new SponsorPaymaster(
            IEntryPoint(address(entryPoint)), address(timelock), vm.addr(signerKey), MAX_COST
        );

        account = new SimpleAccountFactory(entryPoint).createAccount(vm.addr(ownerKey), 0);
        resolver = new Resolver();

        vm.deal(donor, 10 ether);
        vm.prank(donor);
        entryPoint.depositTo{value: 1 ether}(address(paymaster));
    }

    function _op() internal view returns (PackedUserOperation memory op) {
        bytes memory inner = abi.encodeCall(Resolver.setContenthash, (NODE, hex"e301"));
        op.sender = address(account);
        op.nonce = entryPoint.getNonce(address(account), 0);
        op.callData = abi.encodeCall(SimpleAccount.execute, (address(resolver), 0, inner));
        op.accountGasLimits = bytes32((uint256(200_000) << 128) | 200_000);
        op.preVerificationGas = 50_000;
        op.gasFees = bytes32((uint256(1 gwei) << 128) | 10 gwei);
    }

    function _attach(PackedUserOperation memory op, uint48 until, uint48 afterTs, uint256 key)
        internal
        view
        returns (PackedUserOperation memory)
    {
        bytes memory prefix =
            abi.encodePacked(address(paymaster), uint128(200_000), uint128(0));
        op.paymasterAndData = abi.encodePacked(prefix, until, afterTs, new bytes(65));

        bytes32 digest =
            MessageHashUtils.toEthSignedMessageHash(paymaster.getHash(op, until, afterTs));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        op.paymasterAndData = abi.encodePacked(prefix, until, afterTs, r, s, v);
        return op;
    }

    function _signAccount(PackedUserOperation memory op)
        internal
        view
        returns (PackedUserOperation memory)
    {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(entryPoint.getUserOpHash(op));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, digest);
        op.signature = abi.encodePacked(r, s, v);
        return op;
    }

    function _approved() internal view returns (PackedUserOperation memory) {
        return _attach(_op(), uint48(block.timestamp + 300), 0, signerKey);
    }

    function _handle(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler, bundler);
        entryPoint.handleOps(ops, payable(bundler));
    }

    function _expectFailedOp(string memory reason) internal {
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, reason));
    }

    function test_sponsorsAnApprovedOperation() public {
        uint256 depositBefore = entryPoint.balanceOf(address(paymaster));

        _handle(_signAccount(_approved()));

        assertEq(resolver.contenthash(NODE), hex"e301");
        assertLt(entryPoint.balanceOf(address(paymaster)), depositBefore);
        assertEq(address(account).balance, 0);
    }

    function test_rejectsAnotherSigner() public {
        PackedUserOperation memory op =
            _signAccount(_attach(_op(), uint48(block.timestamp + 300), 0, 0xBAD));
        _expectFailedOp("AA34 signature error");
        _handle(op);
    }

    function test_rejectsChangedCallData() public {
        PackedUserOperation memory op = _approved();
        op.callData = abi.encodeCall(SimpleAccount.execute, (donor, 0, ""));
        PackedUserOperation memory signed = _signAccount(op);
        _expectFailedOp("AA34 signature error");
        _handle(signed);
    }

    function test_rejectsChangedGasFees() public {
        PackedUserOperation memory op = _approved();
        op.gasFees = bytes32((uint256(2 gwei) << 128) | 10 gwei);
        PackedUserOperation memory signed = _signAccount(op);
        _expectFailedOp("AA34 signature error");
        _handle(signed);
    }

    function test_rejectsAnotherSender() public {
        PackedUserOperation memory op = _approved();
        SimpleAccount other =
            new SimpleAccountFactory(entryPoint).createAccount(vm.addr(ownerKey), 1);
        op.sender = address(other);
        op.nonce = entryPoint.getNonce(address(other), 0);
        PackedUserOperation memory signed = _signAccount(op);
        _expectFailedOp("AA34 signature error");
        _handle(signed);
    }

    function test_approvalIsBoundToChain() public {
        PackedUserOperation memory op = _approved();
        vm.chainId(block.chainid + 1);
        PackedUserOperation memory signed = _signAccount(op);
        _expectFailedOp("AA34 signature error");
        _handle(signed);
    }

    function test_rejectsAnExpiredApproval() public {
        PackedUserOperation memory op = _signAccount(_approved());
        vm.warp(block.timestamp + 301);
        _expectFailedOp("AA32 paymaster expired or not due");
        _handle(op);
    }

    function test_rejectsAnApprovalNotYetValid() public {
        PackedUserOperation memory op = _signAccount(
            _attach(
                _op(), uint48(block.timestamp + 600), uint48(block.timestamp + 300), signerKey
            )
        );
        _expectFailedOp("AA32 paymaster expired or not due");
        _handle(op);
    }

    function test_cannotReplayAnOperation() public {
        PackedUserOperation memory op = _signAccount(_approved());
        _handle(op);
        _expectFailedOp("AA25 invalid account nonce");
        _handle(op);
    }

    function test_capHoldsEvenWithAValidSignature() public {
        PackedUserOperation memory op = _op();
        op.gasFees = bytes32((uint256(1 gwei) << 128) | 1000 gwei);
        op = _signAccount(_attach(op, uint48(block.timestamp + 300), 0, signerKey));

        vm.expectRevert();
        _handle(op);
        assertEq(resolver.contenthash(NODE), "");
    }

    function test_rejectsMalformedData() public {
        PackedUserOperation memory op = _approved();
        op.paymasterAndData = abi.encodePacked(address(paymaster), uint128(200_000), uint128(0));

        PackedUserOperation memory signed = _signAccount(op);
        vm.expectRevert();
        _handle(signed);
    }

    function test_anyoneCanFundIt() public {
        address stranger = makeAddr("stranger");
        vm.deal(stranger, 1 ether);
        uint256 before = entryPoint.balanceOf(address(paymaster));

        vm.prank(stranger);
        entryPoint.depositTo{value: 0.5 ether}(address(paymaster));

        assertEq(entryPoint.balanceOf(address(paymaster)), before + 0.5 ether);
    }

    function test_signerCannotWithdraw() public {
        vm.prank(vm.addr(signerKey));
        vm.expectRevert();
        paymaster.withdrawTo(payable(vm.addr(signerKey)), 1 ether);
    }

    function test_multisigCannotBypassTheTimelock() public {
        vm.prank(multisig);
        vm.expectRevert();
        paymaster.withdrawTo(payable(multisig), 1 ether);
    }

    function test_withdrawingWaitsForTheTimelock() public {
        bytes memory call = abi.encodeCall(paymaster.withdrawTo, (payable(beneficiary), 1 ether));

        vm.startPrank(multisig);
        timelock.schedule(address(paymaster), 0, call, 0, 0, DELAY);

        vm.expectRevert();
        timelock.execute(address(paymaster), 0, call, 0, 0);

        vm.warp(block.timestamp + DELAY);
        timelock.execute(address(paymaster), 0, call, 0, 0);
        vm.stopPrank();

        assertEq(beneficiary.balance, 1 ether);
    }

    function test_treasuryAcceptsDonationsAndPaysOutOnlyAfterTheDelay() public {
        vm.prank(donor);
        (bool sent,) = address(timelock).call{value: 2 ether}("");
        assertTrue(sent);

        // Top up the paymaster from the treasury.
        bytes memory call = abi.encodeCall(entryPoint.depositTo, (address(paymaster)));
        uint256 before = entryPoint.balanceOf(address(paymaster));

        vm.startPrank(multisig);
        timelock.schedule(address(entryPoint), 1 ether, call, 0, 0, DELAY);
        vm.warp(block.timestamp + DELAY);
        timelock.execute(address(entryPoint), 1 ether, call, 0, 0);
        vm.stopPrank();

        assertEq(entryPoint.balanceOf(address(paymaster)), before + 1 ether);
        assertEq(address(timelock).balance, 1 ether);
    }

    function testFuzz_anyChangedNonceInvalidatesApproval(uint192 key) public {
        vm.assume(key != 0);
        PackedUserOperation memory op = _approved();
        op.nonce = entryPoint.getNonce(address(account), key);
        PackedUserOperation memory signed = _signAccount(op);
        _expectFailedOp("AA34 signature error");
        _handle(signed);
    }

    /// Pinned in test/worker/paymaster.test.ts too: the gateway and this
    /// contract must agree exactly, or every approval would be rejected.
    function test_hashAndSignatureMatchTheGateway() public {
        address at = address(0xAA);
        deployCodeTo(
            "SponsorPaymaster.sol",
            abi.encode(address(entryPoint), multisig, vm.addr(0x516e4), MAX_COST),
            at
        );
        vm.chainId(11155111);

        PackedUserOperation memory op;
        op.sender = address(0xBB);
        op.nonce = 5;
        op.callData = hex"deadbeef";
        op.accountGasLimits = bytes32((uint256(200_000) << 128) | 200_000);
        op.preVerificationGas = 50_000;
        op.gasFees = bytes32((uint256(1 gwei) << 128) | 10 gwei);
        op.paymasterAndData = abi.encodePacked(at, uint128(100_000), uint128(0));

        bytes32 hash = SponsorPaymaster(at).getHash(op, 1_900_000_000, 0);
        assertEq(hash, 0xea42cd66d7e02361929039eb82a1987af1f5676585ab03924f7638d024a1c434);

        bytes memory signature =
            hex"b92190824049754d438013fdcc34266013b448ddd231e44606a86ef7b4d1ea5c22bc71d72a1b9e32e0ebe758019f361294c3199476bc8c969446552c2471129a1c";
        assertEq(
            ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(hash), signature),
            vm.addr(0x516e4)
        );
    }
}

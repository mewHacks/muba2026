/// SHOU Layers 1-2 — the circuit breaker and Seniority Mode, enforced
/// on-chain. The AI (Gonka Router, off-chain) only ever produces a risk
/// tier; this module is the thing that decides what that tier is allowed
/// to do to a transfer. See shou-idea.md §7 for why authority sits with
/// the elder's own pre-committed policy, not a family member in the
/// moment of an attack.
module shou::policy;

use shou::redflag::{Self, DenyList};
use sui::balance::Balance;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;

#[error]
const ETooFewApprovers: vector<u8> = b"Policy must have at least one approver";
#[error]
const EThresholdTooHigh: vector<u8> = b"Approval threshold cannot exceed the number of approvers";
#[error]
const ENotAnApprover: vector<u8> = b"Caller is not a registered approver for this policy";
#[error]
const EAlreadyApproved: vector<u8> = b"This approver has already approved this transfer";
#[error]
const EAlreadyExecuted: vector<u8> = b"This transfer has already been executed";
#[error]
const ETransferBlocked: vector<u8> = b"This transfer was blocked by a guardian";
#[error]
const EThresholdNotMet: vector<u8> = b"Not enough approvals to release a high-risk transfer";
#[error]
const EStillLocked: vector<u8> = b"Transfer is still within its cooldown window";
#[error]
const EWrongPolicy: vector<u8> = b"Object does not belong to this policy";
#[error]
const ERecipientBanned: vector<u8> = b"Recipient address is soft-banned by a Red Flag report";
#[error]
const EWalletPaused: vector<u8> = b"Wallet is currently paused by a guardian";
#[error]
const ENotOwnerOrApprover: vector<u8> = b"Caller must be the policy owner or a registered approver";
#[error]
const EInvalidTier: vector<u8> = b"Unrecognized risk tier";

// Mirrors `RiskAssessment.tier` from the off-chain scorer
// (packages/driver/src/types.ts). The chain never computes a tier, only
// enforces what an already-scored one is allowed to do.
const TIER_LOW: u8 = 0;
const TIER_MEDIUM: u8 = 1;
const TIER_HIGH: u8 = 2;

/// The elder's own pre-committed policy — set while not under duress, at
/// onboarding. This, not a family member acting in the moment, is the
/// thing with authority during a live attack.
public struct SeniorityPolicy has key {
    id: UID,
    owner: address,
    approvers: vector<address>,
    threshold: u8,
    cooldown_ms: u64,
}

/// One pending or resolved transfer. Shared so both the owner and her
/// approvers can act on it from their own transactions.
public struct TransferRequest<phantom T> has key {
    id: UID,
    policy_id: ID,
    recipient: address,
    risk_tier: u8,
    approvals: vector<address>,
    unlock_at_ms: u64,
    executed: bool,
    blocked: bool,
    funds: Balance<T>,
}

/// A guardian-operable panic button, independent of any single transfer.
///
/// ponytail: pausing today is self-serve only (owner or an approver calls
/// `pause` directly) — an automatic pause driven by the off-chain Circuit
/// Breaker needs its own scoped capability; add when that service exists.
public struct WalletGuard has key {
    id: UID,
    owner: address,
    policy_id: ID,
    paused_until_ms: u64,
}

public struct PolicyCreated has copy, drop { policy_id: ID, owner: address }
public struct TransferRequested has copy, drop { request_id: ID, policy_id: ID, tier: u8, unlock_at_ms: u64 }
public struct TransferReleaseApproved has copy, drop { request_id: ID, approver: address }
public struct TransferBlocked has copy, drop { request_id: ID, blocked_by: address }
public struct TransferExecuted has copy, drop { request_id: ID, amount: u64, recipient: address }
public struct WalletPaused has copy, drop { owner: address, paused_until_ms: u64 }

// ---- Policy lifecycle ----

public fun new_policy(
    approvers: vector<address>,
    threshold: u8,
    cooldown_ms: u64,
    ctx: &mut TxContext,
): SeniorityPolicy {
    assert!(approvers.length() > 0, ETooFewApprovers);
    assert!((threshold as u64) <= approvers.length(), EThresholdTooHigh);
    SeniorityPolicy {
        id: object::new(ctx),
        owner: ctx.sender(),
        approvers,
        threshold,
        cooldown_ms,
    }
}

entry fun create_policy(
    approvers: vector<address>,
    threshold: u8,
    cooldown_ms: u64,
    ctx: &mut TxContext,
) {
    let policy = new_policy(approvers, threshold, cooldown_ms, ctx);
    event::emit(PolicyCreated { policy_id: object::id(&policy), owner: policy.owner });
    transfer::share_object(policy);
}

public fun new_guard(policy: &SeniorityPolicy, ctx: &mut TxContext): WalletGuard {
    WalletGuard {
        id: object::new(ctx),
        owner: policy.owner,
        policy_id: object::id(policy),
        paused_until_ms: 0,
    }
}

entry fun create_guard(policy: &SeniorityPolicy, ctx: &mut TxContext) {
    transfer::share_object(new_guard(policy, ctx));
}

/// Owner or any registered approver can pause new submissions until
/// `until_ms`. Does not affect transfers already pending.
entry fun pause(guard: &mut WalletGuard, policy: &SeniorityPolicy, until_ms: u64, ctx: &TxContext) {
    assert!(guard.policy_id == object::id(policy), EWrongPolicy);
    let caller = ctx.sender();
    assert!(caller == guard.owner || policy.approvers.contains(&caller), ENotOwnerOrApprover);
    guard.paused_until_ms = until_ms;
    event::emit(WalletPaused { owner: guard.owner, paused_until_ms: until_ms });
}

// ---- Transfer lifecycle ----

/// Locks `payment` into a new request. The caller (the off-chain Circuit
/// Breaker, on the owner's behalf) supplies `risk_tier` already scored by
/// Gonka Router — this function only enforces what that tier is allowed
/// to do, it never re-evaluates the risk itself.
///
/// LOW-tier requests are still created here rather than paid out inline:
/// `unlock_at_ms` is set to "now", so a client chains `request_transfer`
/// and `execute` in the same PTB for an instant release, instead of
/// special-casing LOW as a separate code path from MEDIUM/HIGH.
public fun submit_transfer<T>(
    policy: &SeniorityPolicy,
    guard: &WalletGuard,
    deny_list: &DenyList,
    payment: Coin<T>,
    recipient: address,
    risk_tier: u8,
    clock: &Clock,
    ctx: &mut TxContext,
): TransferRequest<T> {
    assert!(ctx.sender() == policy.owner, ENotOwnerOrApprover);
    assert!(guard.policy_id == object::id(policy), EWrongPolicy);
    assert!(clock.timestamp_ms() >= guard.paused_until_ms, EWalletPaused);
    assert!(!redflag::is_banned(deny_list, recipient), ERecipientBanned);
    assert!(
        risk_tier == TIER_LOW || risk_tier == TIER_MEDIUM || risk_tier == TIER_HIGH,
        EInvalidTier,
    );

    let unlock_at_ms = if (risk_tier == TIER_MEDIUM) {
        clock.timestamp_ms() + policy.cooldown_ms
    } else {
        clock.timestamp_ms()
    };

    TransferRequest {
        id: object::new(ctx),
        policy_id: object::id(policy),
        recipient,
        risk_tier,
        approvals: vector[],
        unlock_at_ms,
        executed: false,
        blocked: false,
        funds: payment.into_balance(),
    }
}

entry fun request_transfer<T>(
    policy: &SeniorityPolicy,
    guard: &WalletGuard,
    deny_list: &DenyList,
    payment: Coin<T>,
    recipient: address,
    risk_tier: u8,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let request = submit_transfer(policy, guard, deny_list, payment, recipient, risk_tier, clock, ctx);
    event::emit(TransferRequested {
        request_id: object::id(&request),
        policy_id: request.policy_id,
        tier: request.risk_tier,
        unlock_at_ms: request.unlock_at_ms,
    });
    transfer::share_object(request);
}

/// Only meaningful for HIGH-tier requests — approving a LOW/MEDIUM one is
/// a harmless no-op on the release condition, but still gated to
/// registered approvers so the approvals list can't be spammed.
entry fun approve<T>(request: &mut TransferRequest<T>, policy: &SeniorityPolicy, ctx: &TxContext) {
    assert!(request.policy_id == object::id(policy), EWrongPolicy);
    assert!(!request.executed, EAlreadyExecuted);
    assert!(!request.blocked, ETransferBlocked);
    let caller = ctx.sender();
    assert!(policy.approvers.contains(&caller), ENotAnApprover);
    assert!(!request.approvals.contains(&caller), EAlreadyApproved);
    request.approvals.push_back(caller);
    event::emit(TransferReleaseApproved { request_id: object::id(request), approver: caller });
}

/// A guardian cancels a pending transfer during its cooldown — the
/// "guardian can only stop, not approve faster" rule from shou-idea.md
/// §7. Returns the locked funds so the caller decides where they go;
/// `block_and_refund` is the convenience entry point that sends them
/// back to the owner.
public fun block<T>(
    request: &mut TransferRequest<T>,
    policy: &SeniorityPolicy,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(request.policy_id == object::id(policy), EWrongPolicy);
    assert!(!request.executed, EAlreadyExecuted);
    assert!(!request.blocked, ETransferBlocked);
    let caller = ctx.sender();
    assert!(policy.approvers.contains(&caller), ENotAnApprover);
    request.blocked = true;
    event::emit(TransferBlocked { request_id: object::id(request), blocked_by: caller });
    let amount = request.funds.value();
    coin::from_balance(request.funds.split(amount), ctx)
}

entry fun block_and_refund<T>(request: &mut TransferRequest<T>, policy: &SeniorityPolicy, ctx: &mut TxContext) {
    let refund = block(request, policy, ctx);
    transfer::public_transfer(refund, policy.owner);
}

/// Releases the locked funds once the tier's condition is met: HIGH needs
/// `threshold` approvals; LOW/MEDIUM need the cooldown to have elapsed.
/// Callable by anyone once unlocked — release doesn't need to be the
/// owner's own transaction, so a relayer or the recipient can trigger it.
public fun execute<T>(
    request: &mut TransferRequest<T>,
    policy: &SeniorityPolicy,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(request.policy_id == object::id(policy), EWrongPolicy);
    assert!(!request.executed, EAlreadyExecuted);
    assert!(!request.blocked, ETransferBlocked);

    if (request.risk_tier == TIER_HIGH) {
        assert!(request.approvals.length() >= (policy.threshold as u64), EThresholdNotMet);
    } else {
        assert!(clock.timestamp_ms() >= request.unlock_at_ms, EStillLocked);
    };

    request.executed = true;
    let amount = request.funds.value();
    event::emit(TransferExecuted { request_id: object::id(request), amount, recipient: request.recipient });
    coin::from_balance(request.funds.split(amount), ctx)
}

entry fun execute_and_send<T>(request: &mut TransferRequest<T>, policy: &SeniorityPolicy, clock: &Clock, ctx: &mut TxContext) {
    let payout = execute(request, policy, clock, ctx);
    transfer::public_transfer(payout, request.recipient);
}

// ---- Getters ----

public fun owner(policy: &SeniorityPolicy): address { policy.owner }
public fun threshold(policy: &SeniorityPolicy): u8 { policy.threshold }
public fun risk_tier<T>(request: &TransferRequest<T>): u8 { request.risk_tier }
public fun is_executed<T>(request: &TransferRequest<T>): bool { request.executed }
public fun is_blocked<T>(request: &TransferRequest<T>): bool { request.blocked }
public fun approvals_count<T>(request: &TransferRequest<T>): u64 { request.approvals.length() }
public fun unlock_at_ms<T>(request: &TransferRequest<T>): u64 { request.unlock_at_ms }

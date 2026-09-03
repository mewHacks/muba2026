/// SHOU Layers 1-2 — the circuit breaker and Seniority Mode, enforced
/// on-chain. The AI (Gonka Router, off-chain) only ever produces a risk
/// tier; this module decides what that tier is allowed to do to a
/// transfer, and independently escalates on amount so that a scam the AI
/// never saw is still caught. See shou-idea.md §7 for why authority sits
/// with the elder's own pre-committed policy rather than with a family
/// member reacting in the moment of an attack.
module shou::policy;

use shou::enclave::{Self, Enclave, RiskAttestation};
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
const EThresholdTooLow: vector<u8> = b"Approval threshold must be at least 1";
#[error]
const ENotAnApprover: vector<u8> = b"Caller is not a registered approver for this policy";
#[error]
const EAlreadyApproved: vector<u8> = b"This approver has already approved this transfer";
#[error]
const EAlreadyExecuted: vector<u8> = b"This transfer has already been executed";
#[error]
const ETransferBlocked: vector<u8> = b"This transfer was blocked or cancelled";
#[error]
const EThresholdNotMet: vector<u8> = b"Not enough approvals to release a high-risk transfer";
#[error]
const EStillLocked: vector<u8> = b"Transfer is still within its cooldown window";
#[error]
const EWrongPolicy: vector<u8> = b"Object does not belong to this policy";
#[error]
const EWrongDenyList: vector<u8> = b"Deny list is not the one this policy is bound to";
#[error]
const ERecipientBanned: vector<u8> = b"Recipient address is soft-banned by a Red Flag report";
#[error]
const EWalletPaused: vector<u8> = b"Wallet is currently paused by a guardian";
#[error]
const ENotOwner: vector<u8> = b"Caller is not the policy owner";
#[error]
const ENotOwnerOrApprover: vector<u8> = b"Caller must be the policy owner or a registered approver";
#[error]
const EInvalidTier: vector<u8> = b"Unrecognized risk tier";
#[error]
const ECeilingsInverted: vector<u8> = b"review_ceiling must be less than or equal to high_risk_ceiling";
#[error]
const EAttestationMismatch: vector<u8> = b"Risk attestation was signed for a different policy, recipient or amount";

// Mirrors `RiskAssessment.tier` from the off-chain scorer
// (packages/driver/src/types.ts).
const TIER_LOW: u8 = 0;
const TIER_MEDIUM: u8 = 1;
const TIER_HIGH: u8 = 2;

/// The elder's own pre-committed policy — set while not under duress, at
/// onboarding. Pause state lives here rather than in a separate guard
/// object: a standalone guard could be re-minted by anyone against this
/// same policy, which made pausing trivially bypassable.
public struct SeniorityPolicy has key {
    id: UID,
    owner: address,
    approvers: vector<address>,
    threshold: u8,
    cooldown_ms: u64,
    /// Bound at creation. `submit_transfer` rejects any other list, so a
    /// caller cannot swap in an empty one to shed an active ban.
    deny_list_id: ID,
    // Amount-based escalation. These are what still protect her when the
    // AI sees nothing — a phone scam, an unmonitored chat app, or a
    // compromised scorer reporting LOW for everything. Set both to
    // u64::MAX to opt out.
    review_ceiling: u64, // >= this -> at least MEDIUM (cooldown + notify)
    high_risk_ceiling: u64, // >= this -> HIGH (guardian approval required)
    paused_until_ms: u64,
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

public struct PolicyCreated has copy, drop { policy_id: ID, owner: address }
public struct TransferRequested has copy, drop {
    request_id: ID,
    policy_id: ID,
    tier: u8,
    claimed_tier: u8,
    unlock_at_ms: u64,
    message_hash: vector<u8>,
    truth_score: u8,
}
public struct TransferReleaseApproved has copy, drop { request_id: ID, approver: address }
public struct TransferBlocked has copy, drop { request_id: ID, blocked_by: address }
public struct TransferCancelled has copy, drop { request_id: ID }
public struct TransferExecuted has copy, drop { request_id: ID, amount: u64, recipient: address }
public struct WalletPaused has copy, drop { policy_id: ID, paused_until_ms: u64 }

// ---- Policy lifecycle ----

public fun new_policy(
    approvers: vector<address>,
    threshold: u8,
    cooldown_ms: u64,
    deny_list: &DenyList,
    review_ceiling: u64,
    high_risk_ceiling: u64,
    ctx: &mut TxContext,
): SeniorityPolicy {
    assert!(approvers.length() > 0, ETooFewApprovers);
    assert!(threshold > 0, EThresholdTooLow);
    assert!((threshold as u64) <= approvers.length(), EThresholdTooHigh);
    assert!(review_ceiling <= high_risk_ceiling, ECeilingsInverted);
    SeniorityPolicy {
        id: object::new(ctx),
        owner: ctx.sender(),
        approvers,
        threshold,
        cooldown_ms,
        deny_list_id: object::id(deny_list),
        review_ceiling,
        high_risk_ceiling,
        paused_until_ms: 0,
    }
}

entry fun create_policy(
    approvers: vector<address>,
    threshold: u8,
    cooldown_ms: u64,
    deny_list: &DenyList,
    review_ceiling: u64,
    high_risk_ceiling: u64,
    ctx: &mut TxContext,
) {
    let policy = new_policy(
        approvers,
        threshold,
        cooldown_ms,
        deny_list,
        review_ceiling,
        high_risk_ceiling,
        ctx,
    );
    event::emit(PolicyCreated { policy_id: object::id(&policy), owner: policy.owner });
    transfer::share_object(policy);
}

/// Owner or any approver can pause new submissions. Monotonic: it only
/// ever extends the pause, so one approver cannot quietly undo another's
/// (or the owner's) emergency stop by pausing "until now".
entry fun pause(policy: &mut SeniorityPolicy, until_ms: u64, ctx: &TxContext) {
    let caller = ctx.sender();
    assert!(caller == policy.owner || policy.approvers.contains(&caller), ENotOwnerOrApprover);
    if (until_ms > policy.paused_until_ms) {
        policy.paused_until_ms = until_ms;
        event::emit(WalletPaused { policy_id: object::id(policy), paused_until_ms: until_ms });
    }
}

/// Lifting a pause is the owner's call alone.
entry fun unpause(policy: &mut SeniorityPolicy, ctx: &TxContext) {
    assert!(ctx.sender() == policy.owner, ENotOwner);
    policy.paused_until_ms = 0;
    event::emit(WalletPaused { policy_id: object::id(policy), paused_until_ms: 0 });
}

// ---- Transfer lifecycle ----

/// Locks `payment` into a new request. `risk_tier` is supplied by the
/// off-chain Circuit Breaker, already scored by Gonka Router — but it is
/// only ever a *floor*, never a ceiling (see `effective_tier`).
public fun submit_transfer<T>(
    policy: &SeniorityPolicy,
    deny_list: &DenyList,
    payment: Coin<T>,
    recipient: address,
    risk_tier: u8,
    clock: &Clock,
    ctx: &mut TxContext,
): TransferRequest<T> {
    assert!(ctx.sender() == policy.owner, ENotOwner);
    assert!(object::id(deny_list) == policy.deny_list_id, EWrongDenyList);
    assert!(clock.timestamp_ms() >= policy.paused_until_ms, EWalletPaused);
    assert!(
        risk_tier == TIER_LOW || risk_tier == TIER_MEDIUM || risk_tier == TIER_HIGH,
        EInvalidTier,
    );

    let amount = payment.value();
    assert!(!redflag::blocks_amount(deny_list, recipient, amount), ERecipientBanned);

    // The chain derives its own tier from the amount and takes whichever
    // is stricter. A caller can escalate (the AI saw a red-flagged
    // conversation) but can never de-escalate below what the elder's own
    // ceilings demand — so "just mark it LOW" is not an available move,
    // for a compromised scorer or for a scam the AI never saw.
    let effective_tier = max_tier(amount_tier(policy, amount), risk_tier);

    let unlock_at_ms = if (effective_tier == TIER_MEDIUM) {
        clock.timestamp_ms() + policy.cooldown_ms
    } else {
        clock.timestamp_ms()
    };

    TransferRequest {
        id: object::new(ctx),
        policy_id: object::id(policy),
        recipient,
        risk_tier: effective_tier,
        approvals: vector[],
        unlock_at_ms,
        executed: false,
        blocked: false,
        funds: payment.into_balance(),
    }
}

/// Tier implied by amount alone, ignoring anything the AI claimed.
fun amount_tier(policy: &SeniorityPolicy, amount: u64): u8 {
    if (amount >= policy.high_risk_ceiling) TIER_HIGH
    else if (amount >= policy.review_ceiling) TIER_MEDIUM
    else TIER_LOW
}

/// Tier codes are ordered LOW < MEDIUM < HIGH, so "stricter" is just max.
fun max_tier(a: u8, b: u8): u8 {
    if (a > b) a else b
}

/// The attested path. Identical to `submit_transfer`, except the tier is
/// taken from a score the enclave signed rather than from whatever the
/// caller typed — and the attestation is bound to this exact policy,
/// recipient and amount, so a score for a small payment to a known
/// contact cannot be replayed to wave through a large one to a stranger.
///
/// Both paths are safe, but they are safe for different reasons:
///   - unattested: the claimed tier can only ever make things *stricter*
///     (`max_tier`), so lying about it buys an attacker nothing.
///   - attested: the tier is provably the output of the published
///     scoring code, so a *low* score can be trusted too — which is what
///     lets a legitimate everyday payment stay frictionless instead of
///     being treated as suspect.
public fun submit_transfer_attested<T>(
    policy: &SeniorityPolicy,
    deny_list: &DenyList,
    enclave: &Enclave,
    attestation: &RiskAttestation,
    signature: vector<u8>,
    payment: Coin<T>,
    recipient: address,
    clock: &Clock,
    ctx: &mut TxContext,
): TransferRequest<T> {
    enclave.verify(attestation, signature, clock);

    // The signature is only meaningful if it covers *this* transfer.
    assert!(attestation.policy_id() == object::id(policy), EAttestationMismatch);
    assert!(attestation.recipient() == recipient, EAttestationMismatch);
    assert!(attestation.amount() == payment.value(), EAttestationMismatch);

    submit_transfer(policy, deny_list, payment, recipient, attestation.tier(), clock, ctx)
}

entry fun request_transfer_attested<T>(
    policy: &SeniorityPolicy,
    deny_list: &DenyList,
    enclave: &Enclave,
    attestation: &RiskAttestation,
    signature: vector<u8>,
    payment: Coin<T>,
    recipient: address,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let request = submit_transfer_attested(
        policy,
        deny_list,
        enclave,
        attestation,
        signature,
        payment,
        recipient,
        clock,
        ctx,
    );
    event::emit(TransferRequested {
        request_id: object::id(&request),
        policy_id: request.policy_id,
        tier: request.risk_tier,
        claimed_tier: attestation.tier(),
        unlock_at_ms: request.unlock_at_ms,
        message_hash: attestation.message_hash(),
        truth_score: attestation.truth_score(),
    });
    transfer::share_object(request);
}

entry fun request_transfer<T>(
    policy: &SeniorityPolicy,
    deny_list: &DenyList,
    payment: Coin<T>,
    recipient: address,
    risk_tier: u8,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let request = submit_transfer(policy, deny_list, payment, recipient, risk_tier, clock, ctx);
    event::emit(TransferRequested {
        request_id: object::id(&request),
        policy_id: request.policy_id,
        tier: request.risk_tier,
        claimed_tier: risk_tier,
        unlock_at_ms: request.unlock_at_ms,
        message_hash: vector[],
        truth_score: 0,
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

/// A guardian cancels a pending transfer — the "guardian can only stop,
/// not approve faster" rule from shou-idea.md §7.
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

entry fun block_and_refund<T>(
    request: &mut TransferRequest<T>,
    policy: &SeniorityPolicy,
    ctx: &mut TxContext,
) {
    let refund = block(request, policy, ctx);
    transfer::public_transfer(refund, policy.owner);
}

/// The owner's escape hatch. Without this, a HIGH-tier request whose
/// approvers never respond — lost phone, changed number, family away —
/// locks her funds in the shared object permanently, since only an
/// approver can call `block`. Refunds to the owner, so it grants an
/// attacker nothing: the money goes back where it started.
public fun cancel<T>(
    request: &mut TransferRequest<T>,
    policy: &SeniorityPolicy,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(request.policy_id == object::id(policy), EWrongPolicy);
    assert!(!request.executed, EAlreadyExecuted);
    assert!(!request.blocked, ETransferBlocked);
    assert!(ctx.sender() == policy.owner, ENotOwner);
    request.blocked = true;
    event::emit(TransferCancelled { request_id: object::id(request) });
    let amount = request.funds.value();
    coin::from_balance(request.funds.split(amount), ctx)
}

entry fun cancel_and_refund<T>(
    request: &mut TransferRequest<T>,
    policy: &SeniorityPolicy,
    ctx: &mut TxContext,
) {
    let refund = cancel(request, policy, ctx);
    transfer::public_transfer(refund, policy.owner);
}

/// Releases the locked funds once the tier's condition is met: HIGH needs
/// `threshold` approvals; LOW/MEDIUM need the cooldown to have elapsed.
///
/// `public(package)`, NOT `public`, and that is a security boundary rather
/// than a style choice. `TransferRequest` is a shared object, so if this
/// returned `Coin<T>` to any caller, anyone watching for a `TransferRequested`
/// event could compose a PTB that calls this the moment the transfer
/// unlocks and routes the coin to themselves:
///
///     let coin = shou::policy::execute(request, policy, clock);
///     transfer::public_transfer(coin, @attacker);
///
/// Every guard above would pass — the transfer really is unlocked — and the
/// emitted `TransferExecuted` would still name the *intended* recipient, so
/// the theft would read as a successful payment on an explorer.
///
/// Releasing is still permissionless, which is what we wanted: a relayer or
/// the recipient can trigger it. What is no longer negotiable is where the
/// money lands. Go through `execute_and_send`, which pays `request.recipient`.
public(package) fun execute<T>(
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
    event::emit(TransferExecuted {
        request_id: object::id(request),
        amount,
        recipient: request.recipient,
    });
    coin::from_balance(request.funds.split(amount), ctx)
}

entry fun execute_and_send<T>(
    request: &mut TransferRequest<T>,
    policy: &SeniorityPolicy,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let payout = execute(request, policy, clock, ctx);
    transfer::public_transfer(payout, request.recipient);
}

// ---- Getters ----

public fun owner(policy: &SeniorityPolicy): address { policy.owner }

public fun threshold(policy: &SeniorityPolicy): u8 { policy.threshold }

public fun deny_list_id(policy: &SeniorityPolicy): ID { policy.deny_list_id }

public fun paused_until_ms(policy: &SeniorityPolicy): u64 { policy.paused_until_ms }

public fun risk_tier<T>(request: &TransferRequest<T>): u8 { request.risk_tier }

public fun is_executed<T>(request: &TransferRequest<T>): bool { request.executed }

public fun is_blocked<T>(request: &TransferRequest<T>): bool { request.blocked }

public fun approvals_count<T>(request: &TransferRequest<T>): u64 { request.approvals.length() }

public fun unlock_at_ms<T>(request: &TransferRequest<T>): u64 { request.unlock_at_ms }

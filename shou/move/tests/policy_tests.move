#[test_only]
module shou::policy_tests;

use shou::policy::{Self, SeniorityPolicy, TransferRequest};
use shou::redflag::{Self, AdminCap, DenyList, OracleCap};
use std::unit_test::{assert_eq, destroy};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::test_scenario::{Self, Scenario};

const OWNER: address = @0xA1;
const APPROVER_1: address = @0xB1;
const APPROVER_2: address = @0xB2;
const RECIPIENT: address = @0xC1;

const TIER_LOW: u8 = 0;
const TIER_MEDIUM: u8 = 1;
const TIER_HIGH: u8 = 2;

const COOLDOWN_MS: u64 = 60_000;
/// Ceilings high enough to be inert, so the tier tests exercise the
/// AI-supplied tier in isolation.
const NO_CEILING: u64 = 18_446_744_073_709_551_615;
const REVIEW_CEILING: u64 = 100;
const HIGH_CEILING: u64 = 1_000;

/// Publishes the deny list (AdminCap-gated) and a policy bound to it.
fun setup_with(
    scenario: &mut Scenario,
    review_ceiling: u64,
    high_ceiling: u64,
): (SeniorityPolicy, DenyList, Clock) {
    redflag::init_for_testing(scenario.ctx());
    scenario.next_tx(OWNER);

    let admin = scenario.take_from_sender<AdminCap>();
    redflag::create_deny_list(&admin, scenario.ctx());
    redflag::create_oracle_cap(&admin, OWNER, scenario.ctx());
    scenario.return_to_sender(admin);
    scenario.next_tx(OWNER);

    let deny_list = scenario.take_shared<DenyList>();
    policy::create_policy(
        vector[APPROVER_1, APPROVER_2],
        1,
        COOLDOWN_MS,
        &deny_list,
        review_ceiling,
        high_ceiling,
        scenario.ctx(),
    );
    test_scenario::return_shared(deny_list);
    scenario.next_tx(OWNER);

    let policy = scenario.take_shared<SeniorityPolicy>();
    let deny_list = scenario.take_shared<DenyList>();
    let clock = clock::create_for_testing(scenario.ctx());
    (policy, deny_list, clock)
}

fun setup(scenario: &mut Scenario): (SeniorityPolicy, DenyList, Clock) {
    setup_with(scenario, NO_CEILING, NO_CEILING)
}

fun return_fixture(policy: SeniorityPolicy, deny_list: DenyList, clock: Clock) {
    test_scenario::return_shared(policy);
    test_scenario::return_shared(deny_list);
    clock.destroy_for_testing();
}

#[test]
fun create_policy_succeeds() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, deny_list, clock) = setup(&mut scenario);
    assert_eq!(policy.owner(), OWNER);
    assert_eq!(policy.threshold(), 1);
    assert_eq!(policy.deny_list_id(), object::id(&deny_list));
    return_fixture(policy, deny_list, clock);
    scenario.end();
}

#[test, expected_failure(abort_code = policy::EThresholdTooHigh, location = policy)]
fun create_policy_aborts_on_threshold_too_high() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, deny_list, clock) = setup(&mut scenario);
    policy::create_policy(
        vector[APPROVER_1], 2, COOLDOWN_MS, &deny_list, NO_CEILING, NO_CEILING, scenario.ctx(),
    );
    return_fixture(policy, deny_list, clock);
    scenario.end();
}

#[test, expected_failure(abort_code = policy::EThresholdTooLow, location = policy)]
fun create_policy_aborts_on_zero_threshold() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, deny_list, clock) = setup(&mut scenario);
    // 0-of-N would silently disable HIGH-tier approval entirely.
    policy::create_policy(
        vector[APPROVER_1], 0, COOLDOWN_MS, &deny_list, NO_CEILING, NO_CEILING, scenario.ctx(),
    );
    return_fixture(policy, deny_list, clock);
    scenario.end();
}

#[test, expected_failure(abort_code = policy::ETooFewApprovers, location = policy)]
fun create_policy_aborts_on_no_approvers() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, deny_list, clock) = setup(&mut scenario);
    policy::create_policy(
        vector[], 1, COOLDOWN_MS, &deny_list, NO_CEILING, NO_CEILING, scenario.ctx(),
    );
    return_fixture(policy, deny_list, clock);
    scenario.end();
}

#[test, expected_failure(abort_code = policy::ECeilingsInverted, location = policy)]
fun inverted_ceilings_rejected() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, deny_list, clock) = setup(&mut scenario);
    policy::create_policy(
        vector[APPROVER_1], 1, COOLDOWN_MS, &deny_list, HIGH_CEILING, REVIEW_CEILING, scenario.ctx(),
    );
    return_fixture(policy, deny_list, clock);
    scenario.end();
}

// ---- Tier behaviour ----

#[test]
fun low_tier_transfer_executes_immediately() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, deny_list, clock) = setup(&mut scenario);

    let payment = coin::mint_for_testing<SUI>(100, scenario.ctx());
    policy::request_transfer(
        &policy, &deny_list, payment, RECIPIENT, TIER_LOW, &clock, scenario.ctx(),
    );
    return_fixture(policy, deny_list, clock);

    scenario.next_tx(RECIPIENT);
    let policy = scenario.take_shared<SeniorityPolicy>();
    let mut request = scenario.take_shared<TransferRequest<SUI>>();
    let clock = clock::create_for_testing(scenario.ctx());
    policy::execute_and_send(&mut request, &policy, &clock, scenario.ctx());
    assert!(request.is_executed());

    test_scenario::return_shared(policy);
    test_scenario::return_shared(request);
    clock.destroy_for_testing();

    scenario.next_tx(RECIPIENT);
    assert!(scenario.has_most_recent_for_sender<Coin<SUI>>());
    scenario.end();
}

#[test, expected_failure(abort_code = policy::EStillLocked, location = policy)]
fun medium_tier_transfer_locked_before_cooldown() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, deny_list, clock) = setup(&mut scenario);

    let payment = coin::mint_for_testing<SUI>(100, scenario.ctx());
    policy::request_transfer(
        &policy, &deny_list, payment, RECIPIENT, TIER_MEDIUM, &clock, scenario.ctx(),
    );
    return_fixture(policy, deny_list, clock);

    scenario.next_tx(RECIPIENT);
    let policy = scenario.take_shared<SeniorityPolicy>();
    let mut request = scenario.take_shared<TransferRequest<SUI>>();
    let clock = clock::create_for_testing(scenario.ctx());
    policy::execute_and_send(&mut request, &policy, &clock, scenario.ctx());

    test_scenario::return_shared(policy);
    test_scenario::return_shared(request);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun medium_tier_transfer_executes_after_cooldown() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, deny_list, clock) = setup(&mut scenario);

    let payment = coin::mint_for_testing<SUI>(100, scenario.ctx());
    policy::request_transfer(
        &policy, &deny_list, payment, RECIPIENT, TIER_MEDIUM, &clock, scenario.ctx(),
    );
    return_fixture(policy, deny_list, clock);

    scenario.next_tx(RECIPIENT);
    let policy = scenario.take_shared<SeniorityPolicy>();
    let mut request = scenario.take_shared<TransferRequest<SUI>>();
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.increment_for_testing(COOLDOWN_MS);
    policy::execute_and_send(&mut request, &policy, &clock, scenario.ctx());
    assert!(request.is_executed());

    test_scenario::return_shared(policy);
    test_scenario::return_shared(request);
    clock.destroy_for_testing();
    scenario.end();
}

#[test, expected_failure(abort_code = policy::EThresholdNotMet, location = policy)]
fun high_tier_transfer_blocked_before_approval() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, deny_list, clock) = setup(&mut scenario);

    let payment = coin::mint_for_testing<SUI>(100, scenario.ctx());
    policy::request_transfer(
        &policy, &deny_list, payment, RECIPIENT, TIER_HIGH, &clock, scenario.ctx(),
    );
    return_fixture(policy, deny_list, clock);

    scenario.next_tx(RECIPIENT);
    let policy = scenario.take_shared<SeniorityPolicy>();
    let mut request = scenario.take_shared<TransferRequest<SUI>>();
    let clock = clock::create_for_testing(scenario.ctx());
    policy::execute_and_send(&mut request, &policy, &clock, scenario.ctx());

    test_scenario::return_shared(policy);
    test_scenario::return_shared(request);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun high_tier_transfer_executes_after_approval() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, deny_list, clock) = setup(&mut scenario);

    let payment = coin::mint_for_testing<SUI>(100, scenario.ctx());
    policy::request_transfer(
        &policy, &deny_list, payment, RECIPIENT, TIER_HIGH, &clock, scenario.ctx(),
    );
    return_fixture(policy, deny_list, clock);

    scenario.next_tx(APPROVER_1);
    let policy = scenario.take_shared<SeniorityPolicy>();
    let mut request = scenario.take_shared<TransferRequest<SUI>>();
    policy::approve(&mut request, &policy, scenario.ctx());
    assert_eq!(request.approvals_count(), 1);
    test_scenario::return_shared(policy);
    test_scenario::return_shared(request);

    scenario.next_tx(RECIPIENT);
    let policy = scenario.take_shared<SeniorityPolicy>();
    let mut request = scenario.take_shared<TransferRequest<SUI>>();
    let clock = clock::create_for_testing(scenario.ctx());
    policy::execute_and_send(&mut request, &policy, &clock, scenario.ctx());
    assert!(request.is_executed());

    test_scenario::return_shared(policy);
    test_scenario::return_shared(request);
    clock.destroy_for_testing();
    scenario.end();
}

#[test, expected_failure(abort_code = policy::ENotAnApprover, location = policy)]
fun wrong_approver_cannot_approve() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, deny_list, clock) = setup(&mut scenario);

    let payment = coin::mint_for_testing<SUI>(100, scenario.ctx());
    policy::request_transfer(
        &policy, &deny_list, payment, RECIPIENT, TIER_HIGH, &clock, scenario.ctx(),
    );
    return_fixture(policy, deny_list, clock);

    scenario.next_tx(RECIPIENT);
    let policy = scenario.take_shared<SeniorityPolicy>();
    let mut request = scenario.take_shared<TransferRequest<SUI>>();
    policy::approve(&mut request, &policy, scenario.ctx());

    test_scenario::return_shared(policy);
    test_scenario::return_shared(request);
    scenario.end();
}

#[test, expected_failure(abort_code = policy::EAlreadyApproved, location = policy)]
fun cannot_approve_twice() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, deny_list, clock) = setup(&mut scenario);

    let payment = coin::mint_for_testing<SUI>(100, scenario.ctx());
    policy::request_transfer(
        &policy, &deny_list, payment, RECIPIENT, TIER_HIGH, &clock, scenario.ctx(),
    );
    return_fixture(policy, deny_list, clock);

    scenario.next_tx(APPROVER_1);
    let policy = scenario.take_shared<SeniorityPolicy>();
    let mut request = scenario.take_shared<TransferRequest<SUI>>();
    policy::approve(&mut request, &policy, scenario.ctx());
    policy::approve(&mut request, &policy, scenario.ctx());

    test_scenario::return_shared(policy);
    test_scenario::return_shared(request);
    scenario.end();
}

// ---- Amount-based escalation ----
//
// Regression tests for the exploit found in review: a large transfer was
// declared TIER_LOW by the caller and executed with no approval and no
// cooldown, under a policy specifying both. The chain now derives its own
// tier from the amount and takes the stricter of the two.

#[test, expected_failure(abort_code = policy::EThresholdNotMet, location = policy)]
fun large_amount_declared_low_still_needs_approval() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, deny_list, clock) = setup_with(&mut scenario, REVIEW_CEILING, HIGH_CEILING);

    let payment = coin::mint_for_testing<SUI>(HIGH_CEILING, scenario.ctx());
    policy::request_transfer(
        &policy, &deny_list, payment, RECIPIENT, TIER_LOW, &clock, scenario.ctx(),
    );
    return_fixture(policy, deny_list, clock);

    scenario.next_tx(RECIPIENT);
    let policy = scenario.take_shared<SeniorityPolicy>();
    let mut request = scenario.take_shared<TransferRequest<SUI>>();
    assert_eq!(request.risk_tier(), TIER_HIGH);
    let clock = clock::create_for_testing(scenario.ctx());
    policy::execute_and_send(&mut request, &policy, &clock, scenario.ctx());

    test_scenario::return_shared(policy);
    test_scenario::return_shared(request);
    clock.destroy_for_testing();
    scenario.end();
}

#[test, expected_failure(abort_code = policy::EStillLocked, location = policy)]
fun mid_amount_declared_low_still_gets_cooldown() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, deny_list, clock) = setup_with(&mut scenario, REVIEW_CEILING, HIGH_CEILING);

    let payment = coin::mint_for_testing<SUI>(REVIEW_CEILING, scenario.ctx());
    policy::request_transfer(
        &policy, &deny_list, payment, RECIPIENT, TIER_LOW, &clock, scenario.ctx(),
    );
    return_fixture(policy, deny_list, clock);

    scenario.next_tx(RECIPIENT);
    let policy = scenario.take_shared<SeniorityPolicy>();
    let mut request = scenario.take_shared<TransferRequest<SUI>>();
    let clock = clock::create_for_testing(scenario.ctx());
    policy::execute_and_send(&mut request, &policy, &clock, scenario.ctx());

    test_scenario::return_shared(policy);
    test_scenario::return_shared(request);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun small_amount_below_ceilings_still_executes_immediately() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, deny_list, clock) = setup_with(&mut scenario, REVIEW_CEILING, HIGH_CEILING);

    let payment = coin::mint_for_testing<SUI>(REVIEW_CEILING - 1, scenario.ctx());
    policy::request_transfer(
        &policy, &deny_list, payment, RECIPIENT, TIER_LOW, &clock, scenario.ctx(),
    );
    return_fixture(policy, deny_list, clock);

    scenario.next_tx(RECIPIENT);
    let policy = scenario.take_shared<SeniorityPolicy>();
    let mut request = scenario.take_shared<TransferRequest<SUI>>();
    let clock = clock::create_for_testing(scenario.ctx());
    policy::execute_and_send(&mut request, &policy, &clock, scenario.ctx());
    assert!(request.is_executed());

    test_scenario::return_shared(policy);
    test_scenario::return_shared(request);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun ai_can_still_escalate_a_small_amount() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, deny_list, clock) = setup_with(&mut scenario, REVIEW_CEILING, HIGH_CEILING);

    // Tiny amount, but the AI saw a red-flagged conversation. Escalation
    // has to work in this direction too, not only from the amount.
    let payment = coin::mint_for_testing<SUI>(1, scenario.ctx());
    policy::request_transfer(
        &policy, &deny_list, payment, RECIPIENT, TIER_HIGH, &clock, scenario.ctx(),
    );
    return_fixture(policy, deny_list, clock);

    scenario.next_tx(APPROVER_1);
    let policy = scenario.take_shared<SeniorityPolicy>();
    let request = scenario.take_shared<TransferRequest<SUI>>();
    assert_eq!(request.risk_tier(), TIER_HIGH);
    test_scenario::return_shared(policy);
    test_scenario::return_shared(request);
    scenario.end();
}

// ---- Object-substitution regressions ----

#[test, expected_failure(abort_code = policy::EWrongDenyList, location = policy)]
fun cannot_swap_in_a_different_deny_list() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, deny_list, clock) = setup(&mut scenario);

    // The attack this blocks: ban a recipient on the real list, then
    // launder the transfer through a second, empty list. Before the fix,
    // submit_transfer accepted *any* DenyList handed to it, so the ban
    // was one extra object away from meaningless. The identity check runs
    // before the ban lookup, so an empty decoy is enough to prove it.
    let admin = scenario.take_from_sender<AdminCap>();
    let decoy = redflag::new_deny_list(&admin, scenario.ctx());

    let payment = coin::mint_for_testing<SUI>(100, scenario.ctx());
    policy::request_transfer(
        &policy, &decoy, payment, RECIPIENT, TIER_LOW, &clock, scenario.ctx(),
    );

    destroy(decoy);
    scenario.return_to_sender(admin);
    return_fixture(policy, deny_list, clock);
    scenario.end();
}

#[test, expected_failure(abort_code = policy::EWalletPaused, location = policy)]
fun paused_wallet_blocks_new_submission() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, deny_list, clock) = setup(&mut scenario);
    let mut policy = policy;

    policy::pause(&mut policy, clock.timestamp_ms() + COOLDOWN_MS, scenario.ctx());
    let payment = coin::mint_for_testing<SUI>(100, scenario.ctx());
    policy::request_transfer(
        &policy, &deny_list, payment, RECIPIENT, TIER_LOW, &clock, scenario.ctx(),
    );

    return_fixture(policy, deny_list, clock);
    scenario.end();
}

#[test]
fun approver_cannot_shorten_an_existing_pause() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, deny_list, clock) = setup(&mut scenario);
    let mut policy = policy;

    policy::pause(&mut policy, 500_000, scenario.ctx());
    test_scenario::return_shared(policy);
    scenario.next_tx(APPROVER_1);

    // An approver "pausing until now" must not clear the owner's pause.
    let mut policy = scenario.take_shared<SeniorityPolicy>();
    policy::pause(&mut policy, 0, scenario.ctx());
    assert_eq!(policy.paused_until_ms(), 500_000);

    return_fixture(policy, deny_list, clock);
    scenario.end();
}

#[test, expected_failure(abort_code = policy::ENotOwner, location = policy)]
fun approver_cannot_unpause() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, deny_list, clock) = setup(&mut scenario);
    let mut policy = policy;

    policy::pause(&mut policy, 500_000, scenario.ctx());
    test_scenario::return_shared(policy);
    scenario.next_tx(APPROVER_1);

    let mut policy = scenario.take_shared<SeniorityPolicy>();
    policy::unpause(&mut policy, scenario.ctx());

    return_fixture(policy, deny_list, clock);
    scenario.end();
}

// ---- Guardian block and owner cancel ----

#[test, expected_failure(abort_code = policy::ETransferBlocked, location = policy)]
fun guardian_can_block_a_pending_transfer() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, deny_list, clock) = setup(&mut scenario);

    let payment = coin::mint_for_testing<SUI>(100, scenario.ctx());
    policy::request_transfer(
        &policy, &deny_list, payment, RECIPIENT, TIER_MEDIUM, &clock, scenario.ctx(),
    );
    return_fixture(policy, deny_list, clock);

    scenario.next_tx(APPROVER_1);
    let policy = scenario.take_shared<SeniorityPolicy>();
    let mut request = scenario.take_shared<TransferRequest<SUI>>();
    policy::block_and_refund(&mut request, &policy, scenario.ctx());
    assert!(request.is_blocked());

    // A blocked transfer can never execute, even after the cooldown.
    let clock = clock::create_for_testing(scenario.ctx());
    policy::execute_and_send(&mut request, &policy, &clock, scenario.ctx());

    test_scenario::return_shared(policy);
    test_scenario::return_shared(request);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun owner_can_reclaim_a_stranded_high_tier_transfer() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, deny_list, clock) = setup(&mut scenario);

    // HIGH tier, and the approvers never respond — without cancel() these
    // funds would be locked in the shared object permanently, since only
    // an approver may call block().
    let payment = coin::mint_for_testing<SUI>(100, scenario.ctx());
    policy::request_transfer(
        &policy, &deny_list, payment, RECIPIENT, TIER_HIGH, &clock, scenario.ctx(),
    );
    return_fixture(policy, deny_list, clock);

    scenario.next_tx(OWNER);
    let policy = scenario.take_shared<SeniorityPolicy>();
    let mut request = scenario.take_shared<TransferRequest<SUI>>();
    policy::cancel_and_refund(&mut request, &policy, scenario.ctx());
    assert!(request.is_blocked());
    test_scenario::return_shared(policy);
    test_scenario::return_shared(request);

    scenario.next_tx(OWNER);
    assert!(scenario.has_most_recent_for_sender<Coin<SUI>>());
    scenario.end();
}

#[test, expected_failure(abort_code = policy::ENotOwner, location = policy)]
fun non_owner_cannot_cancel() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, deny_list, clock) = setup(&mut scenario);

    let payment = coin::mint_for_testing<SUI>(100, scenario.ctx());
    policy::request_transfer(
        &policy, &deny_list, payment, RECIPIENT, TIER_HIGH, &clock, scenario.ctx(),
    );
    return_fixture(policy, deny_list, clock);

    scenario.next_tx(RECIPIENT);
    let policy = scenario.take_shared<SeniorityPolicy>();
    let mut request = scenario.take_shared<TransferRequest<SUI>>();
    policy::cancel_and_refund(&mut request, &policy, scenario.ctx());

    test_scenario::return_shared(policy);
    test_scenario::return_shared(request);
    scenario.end();
}

// ---- Soft ban ----

#[test, expected_failure(abort_code = policy::ERecipientBanned, location = policy)]
fun banned_recipient_blocks_amount_above_ceiling() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, deny_list, clock) = setup(&mut scenario);
    let mut deny_list = deny_list;

    let oracle = scenario.take_from_sender<OracleCap>();
    redflag::report(&mut deny_list, &oracle, RECIPIENT, 90, 50, &clock);
    scenario.return_to_sender(oracle);

    let payment = coin::mint_for_testing<SUI>(51, scenario.ctx());
    policy::request_transfer(
        &policy, &deny_list, payment, RECIPIENT, TIER_LOW, &clock, scenario.ctx(),
    );

    return_fixture(policy, deny_list, clock);
    scenario.end();
}

#[test]
fun banned_recipient_still_allows_daily_necessities() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, deny_list, clock) = setup(&mut scenario);
    let mut deny_list = deny_list;

    let oracle = scenario.take_from_sender<OracleCap>();
    redflag::report(&mut deny_list, &oracle, RECIPIENT, 90, 50, &clock);
    scenario.return_to_sender(oracle);

    // At or below the ban ceiling, the transfer still goes through — the
    // "soft" in soft ban (shou-idea.md §2, Layer 3).
    let payment = coin::mint_for_testing<SUI>(50, scenario.ctx());
    policy::request_transfer(
        &policy, &deny_list, payment, RECIPIENT, TIER_LOW, &clock, scenario.ctx(),
    );

    return_fixture(policy, deny_list, clock);
    scenario.next_tx(OWNER);
    let request = scenario.take_shared<TransferRequest<SUI>>();
    assert!(!request.is_blocked());
    test_scenario::return_shared(request);
    scenario.end();
}

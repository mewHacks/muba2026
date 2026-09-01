#[test_only]
module shou::policy_tests;

use shou::policy::{Self, SeniorityPolicy, TransferRequest, WalletGuard};
use shou::redflag::{Self, DenyList};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::test_scenario::{Self, Scenario};
use std::unit_test::assert_eq;

const OWNER: address = @0xA1;
const APPROVER_1: address = @0xB1;
const APPROVER_2: address = @0xB2;
const RECIPIENT: address = @0xC1;

const TIER_LOW: u8 = 0;
const TIER_MEDIUM: u8 = 1;
const TIER_HIGH: u8 = 2;

const COOLDOWN_MS: u64 = 60_000;

/// Shared fixture: a 1-of-2 policy, an unpaused guard, and an empty deny
/// list, all freshly re-taken so callers get objects usable in the
/// transaction they're already in.
fun setup(scenario: &mut Scenario): (SeniorityPolicy, WalletGuard, DenyList, Clock) {
    policy::create_policy(vector[APPROVER_1, APPROVER_2], 1, COOLDOWN_MS, scenario.ctx());
    redflag::create_deny_list(scenario.ctx());
    scenario.next_tx(OWNER);

    let policy = scenario.take_shared<SeniorityPolicy>();
    policy::create_guard(&policy, scenario.ctx());
    test_scenario::return_shared(policy);
    scenario.next_tx(OWNER);

    let policy = scenario.take_shared<SeniorityPolicy>();
    let guard = scenario.take_shared<WalletGuard>();
    let deny_list = scenario.take_shared<DenyList>();
    let clock = clock::create_for_testing(scenario.ctx());
    (policy, guard, deny_list, clock)
}

fun return_fixture(policy: SeniorityPolicy, guard: WalletGuard, deny_list: DenyList, clock: Clock) {
    test_scenario::return_shared(policy);
    test_scenario::return_shared(guard);
    test_scenario::return_shared(deny_list);
    clock.destroy_for_testing();
}

#[test]
fun create_policy_succeeds() {
    let mut scenario = test_scenario::begin(OWNER);
    policy::create_policy(vector[APPROVER_1, APPROVER_2], 1, COOLDOWN_MS, scenario.ctx());

    scenario.next_tx(OWNER);
    let policy = scenario.take_shared<SeniorityPolicy>();
    assert_eq!(policy.owner(), OWNER);
    assert_eq!(policy.threshold(), 1);
    test_scenario::return_shared(policy);
    scenario.end();
}

#[test, expected_failure(abort_code = policy::EThresholdTooHigh, location = policy)]
fun create_policy_aborts_on_threshold_too_high() {
    let mut scenario = test_scenario::begin(OWNER);
    policy::create_policy(vector[APPROVER_1], 2, COOLDOWN_MS, scenario.ctx());
    scenario.end();
}

#[test, expected_failure(abort_code = policy::ETooFewApprovers, location = policy)]
fun create_policy_aborts_on_no_approvers() {
    let mut scenario = test_scenario::begin(OWNER);
    policy::create_policy(vector[], 0, COOLDOWN_MS, scenario.ctx());
    scenario.end();
}

#[test]
fun low_tier_transfer_executes_immediately() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, guard, deny_list, clock) = setup(&mut scenario);

    let payment = coin::mint_for_testing<SUI>(100, scenario.ctx());
    policy::request_transfer(&policy, &guard, &deny_list, payment, RECIPIENT, TIER_LOW, &clock, scenario.ctx());
    return_fixture(policy, guard, deny_list, clock);

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
    let (policy, guard, deny_list, clock) = setup(&mut scenario);

    let payment = coin::mint_for_testing<SUI>(100, scenario.ctx());
    policy::request_transfer(&policy, &guard, &deny_list, payment, RECIPIENT, TIER_MEDIUM, &clock, scenario.ctx());
    return_fixture(policy, guard, deny_list, clock);

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
    let (policy, guard, deny_list, mut clock) = setup(&mut scenario);

    let payment = coin::mint_for_testing<SUI>(100, scenario.ctx());
    policy::request_transfer(&policy, &guard, &deny_list, payment, RECIPIENT, TIER_MEDIUM, &clock, scenario.ctx());
    clock.increment_for_testing(COOLDOWN_MS);
    return_fixture(policy, guard, deny_list, clock);

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
    let (policy, guard, deny_list, clock) = setup(&mut scenario);

    let payment = coin::mint_for_testing<SUI>(100, scenario.ctx());
    policy::request_transfer(&policy, &guard, &deny_list, payment, RECIPIENT, TIER_HIGH, &clock, scenario.ctx());
    return_fixture(policy, guard, deny_list, clock);

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
    let (policy, guard, deny_list, clock) = setup(&mut scenario);

    let payment = coin::mint_for_testing<SUI>(100, scenario.ctx());
    policy::request_transfer(&policy, &guard, &deny_list, payment, RECIPIENT, TIER_HIGH, &clock, scenario.ctx());
    return_fixture(policy, guard, deny_list, clock);

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
    let (policy, guard, deny_list, clock) = setup(&mut scenario);

    let payment = coin::mint_for_testing<SUI>(100, scenario.ctx());
    policy::request_transfer(&policy, &guard, &deny_list, payment, RECIPIENT, TIER_HIGH, &clock, scenario.ctx());
    return_fixture(policy, guard, deny_list, clock);

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
    let (policy, guard, deny_list, clock) = setup(&mut scenario);

    let payment = coin::mint_for_testing<SUI>(100, scenario.ctx());
    policy::request_transfer(&policy, &guard, &deny_list, payment, RECIPIENT, TIER_HIGH, &clock, scenario.ctx());
    return_fixture(policy, guard, deny_list, clock);

    scenario.next_tx(APPROVER_1);
    let policy = scenario.take_shared<SeniorityPolicy>();
    let mut request = scenario.take_shared<TransferRequest<SUI>>();
    policy::approve(&mut request, &policy, scenario.ctx());
    policy::approve(&mut request, &policy, scenario.ctx());

    test_scenario::return_shared(policy);
    test_scenario::return_shared(request);
    scenario.end();
}

#[test, expected_failure(abort_code = policy::ERecipientBanned, location = policy)]
fun denylisted_recipient_blocks_submission() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, guard, mut deny_list, clock) = setup(&mut scenario);

    redflag::report(&mut deny_list, RECIPIENT, 90, &clock);
    let payment = coin::mint_for_testing<SUI>(100, scenario.ctx());
    policy::request_transfer(&policy, &guard, &deny_list, payment, RECIPIENT, TIER_LOW, &clock, scenario.ctx());

    return_fixture(policy, guard, deny_list, clock);
    scenario.end();
}

#[test, expected_failure(abort_code = policy::ETransferBlocked, location = policy)]
fun guardian_can_block_a_pending_transfer() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, guard, deny_list, clock) = setup(&mut scenario);

    let payment = coin::mint_for_testing<SUI>(100, scenario.ctx());
    policy::request_transfer(&policy, &guard, &deny_list, payment, RECIPIENT, TIER_MEDIUM, &clock, scenario.ctx());
    return_fixture(policy, guard, deny_list, clock);

    scenario.next_tx(APPROVER_1);
    let policy = scenario.take_shared<SeniorityPolicy>();
    let mut request = scenario.take_shared<TransferRequest<SUI>>();
    policy::block_and_refund(&mut request, &policy, scenario.ctx());
    assert!(request.is_blocked());

    // Blocked transfers can never execute, even after the cooldown — this
    // second call is the actual assertion, not just the block() call above.
    let clock = clock::create_for_testing(scenario.ctx());
    policy::execute_and_send(&mut request, &policy, &clock, scenario.ctx());

    test_scenario::return_shared(policy);
    test_scenario::return_shared(request);
    clock.destroy_for_testing();
    scenario.end();
}

#[test, expected_failure(abort_code = policy::EWalletPaused, location = policy)]
fun paused_wallet_blocks_new_submission() {
    let mut scenario = test_scenario::begin(OWNER);
    let (policy, mut guard, deny_list, clock) = setup(&mut scenario);

    policy::pause(&mut guard, &policy, clock.timestamp_ms() + COOLDOWN_MS, scenario.ctx());
    let payment = coin::mint_for_testing<SUI>(100, scenario.ctx());
    policy::request_transfer(&policy, &guard, &deny_list, payment, RECIPIENT, TIER_LOW, &clock, scenario.ctx());

    return_fixture(policy, guard, deny_list, clock);
    scenario.end();
}

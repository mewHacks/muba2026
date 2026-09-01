#[test_only]
module shou::redflag_tests;

use shou::redflag::{Self, DenyList, StaffCap, AdminCap};
use sui::clock;
use sui::test_scenario;
use std::unit_test::assert_eq;

const OWNER: address = @0xA1;
const STAFF: address = @0xB1;
const SCAMMER: address = @0xC1;

#[test]
fun report_marks_address_banned() {
    let mut scenario = test_scenario::begin(OWNER);
    redflag::create_deny_list(scenario.ctx());
    let clock = clock::create_for_testing(scenario.ctx());

    scenario.next_tx(OWNER);
    let mut deny_list = scenario.take_shared<DenyList>();
    redflag::report(&mut deny_list, SCAMMER, 90, &clock);

    assert!(deny_list.is_banned(SCAMMER));
    assert_eq!(deny_list.plausibility_score(SCAMMER), 90);

    test_scenario::return_shared(deny_list);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun staff_can_clear_a_banned_address() {
    let mut scenario = test_scenario::begin(OWNER);
    redflag::init_for_testing(scenario.ctx());
    redflag::create_deny_list(scenario.ctx());
    let clock = clock::create_for_testing(scenario.ctx());

    scenario.next_tx(OWNER);
    let admin = scenario.take_from_sender<AdminCap>();
    redflag::create_staff_cap(&admin, STAFF, scenario.ctx());
    scenario.return_to_sender(admin);

    let mut deny_list = scenario.take_shared<DenyList>();
    redflag::report(&mut deny_list, SCAMMER, 90, &clock);
    test_scenario::return_shared(deny_list);

    scenario.next_tx(STAFF);
    let staff_cap = scenario.take_from_sender<StaffCap>();
    let mut deny_list = scenario.take_shared<DenyList>();
    redflag::clear(&mut deny_list, &staff_cap, SCAMMER);

    assert!(!deny_list.is_banned(SCAMMER));

    test_scenario::return_shared(deny_list);
    scenario.return_to_sender(staff_cap);
    clock.destroy_for_testing();
    scenario.end();
}

#[test, expected_failure(abort_code = redflag::ENotBanned, location = redflag)]
fun clear_aborts_if_not_banned() {
    let mut scenario = test_scenario::begin(OWNER);
    redflag::init_for_testing(scenario.ctx());
    redflag::create_deny_list(scenario.ctx());

    scenario.next_tx(OWNER);
    let admin = scenario.take_from_sender<AdminCap>();
    redflag::create_staff_cap(&admin, STAFF, scenario.ctx());
    scenario.return_to_sender(admin);

    scenario.next_tx(STAFF);
    let staff_cap = scenario.take_from_sender<StaffCap>();
    let mut deny_list = scenario.take_shared<DenyList>();
    redflag::clear(&mut deny_list, &staff_cap, SCAMMER);

    scenario.return_to_sender(staff_cap);
    test_scenario::return_shared(deny_list);
    scenario.end();
}

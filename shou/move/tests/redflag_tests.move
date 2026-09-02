#[test_only]
module shou::redflag_tests;

use shou::redflag::{Self, AdminCap, DenyList, OracleCap, StaffCap};
use std::unit_test::assert_eq;
use sui::clock;
use sui::test_scenario;

const OWNER: address = @0xA1;
const STAFF: address = @0xB1;
const ORACLE: address = @0xB2;
const SCAMMER: address = @0xC1;
const GRIEFER: address = @0xD1;

#[test]
fun report_marks_address_banned() {
    let mut scenario = test_scenario::begin(OWNER);
    redflag::init_for_testing(scenario.ctx());
    let clock = clock::create_for_testing(scenario.ctx());

    scenario.next_tx(OWNER);
    let admin = scenario.take_from_sender<AdminCap>();
    redflag::create_deny_list(&admin, scenario.ctx());
    redflag::create_oracle_cap(&admin, ORACLE, scenario.ctx());
    scenario.return_to_sender(admin);

    scenario.next_tx(ORACLE);
    let oracle = scenario.take_from_sender<OracleCap>();
    let mut deny_list = scenario.take_shared<DenyList>();
    redflag::report(&mut deny_list, &oracle, SCAMMER, 90, 0, &clock);

    assert!(deny_list.is_banned(SCAMMER));
    assert_eq!(deny_list.plausibility_score(SCAMMER), 90);
    assert!(deny_list.blocks_amount(SCAMMER, 1));

    test_scenario::return_shared(deny_list);
    scenario.return_to_sender(oracle);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun soft_ban_permits_amounts_at_or_below_ceiling() {
    let mut scenario = test_scenario::begin(OWNER);
    redflag::init_for_testing(scenario.ctx());
    let clock = clock::create_for_testing(scenario.ctx());

    scenario.next_tx(OWNER);
    let admin = scenario.take_from_sender<AdminCap>();
    redflag::create_deny_list(&admin, scenario.ctx());
    redflag::create_oracle_cap(&admin, ORACLE, scenario.ctx());
    scenario.return_to_sender(admin);

    scenario.next_tx(ORACLE);
    let oracle = scenario.take_from_sender<OracleCap>();
    let mut deny_list = scenario.take_shared<DenyList>();
    redflag::report(&mut deny_list, &oracle, SCAMMER, 90, 100, &clock);

    assert!(!deny_list.blocks_amount(SCAMMER, 100)); // groceries still work
    assert!(deny_list.blocks_amount(SCAMMER, 101)); // the scam does not
    assert!(!deny_list.blocks_amount(GRIEFER, 999_999)); // unbanned, unaffected

    test_scenario::return_shared(deny_list);
    scenario.return_to_sender(oracle);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun re_reporting_refreshes_rather_than_aborting() {
    let mut scenario = test_scenario::begin(OWNER);
    redflag::init_for_testing(scenario.ctx());
    let clock = clock::create_for_testing(scenario.ctx());

    scenario.next_tx(OWNER);
    let admin = scenario.take_from_sender<AdminCap>();
    redflag::create_deny_list(&admin, scenario.ctx());
    redflag::create_oracle_cap(&admin, ORACLE, scenario.ctx());
    scenario.return_to_sender(admin);

    scenario.next_tx(ORACLE);
    let oracle = scenario.take_from_sender<OracleCap>();
    let mut deny_list = scenario.take_shared<DenyList>();
    redflag::report(&mut deny_list, &oracle, SCAMMER, 60, 500, &clock);
    redflag::report(&mut deny_list, &oracle, SCAMMER, 95, 0, &clock);

    assert_eq!(deny_list.plausibility_score(SCAMMER), 95);
    assert!(deny_list.blocks_amount(SCAMMER, 1));

    test_scenario::return_shared(deny_list);
    scenario.return_to_sender(oracle);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun staff_can_clear_a_banned_address() {
    let mut scenario = test_scenario::begin(OWNER);
    redflag::init_for_testing(scenario.ctx());
    let clock = clock::create_for_testing(scenario.ctx());

    scenario.next_tx(OWNER);
    let admin = scenario.take_from_sender<AdminCap>();
    redflag::create_deny_list(&admin, scenario.ctx());
    redflag::create_staff_cap(&admin, STAFF, scenario.ctx());
    redflag::create_oracle_cap(&admin, ORACLE, scenario.ctx());
    scenario.return_to_sender(admin);

    scenario.next_tx(ORACLE);
    let oracle = scenario.take_from_sender<OracleCap>();
    let mut deny_list = scenario.take_shared<DenyList>();
    redflag::report(&mut deny_list, &oracle, SCAMMER, 90, 0, &clock);
    test_scenario::return_shared(deny_list);
    scenario.return_to_sender(oracle);

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

    scenario.next_tx(OWNER);
    let admin = scenario.take_from_sender<AdminCap>();
    redflag::create_deny_list(&admin, scenario.ctx());
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

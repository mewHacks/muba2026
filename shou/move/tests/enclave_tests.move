#[test_only]
module shou::enclave_tests;

use shou::enclave::{Self, Enclave, EnclaveConfig};
use shou::redflag::{Self, AdminCap};
use std::unit_test::{assert_eq, destroy};
use sui::clock;
use sui::test_scenario;

const ADMIN: address = @0xA1;
const RECIPIENT: address = @0xC1;

// A real ed25519 keypair and a real signature over the BCS bytes of the
// attestation built below. Move cannot sign, so these come from the
// enclave-side signer — regenerate with:
//     npm run fixture --prefix shou/enclave
// This is also the load-bearing check that the BCS layout in
// shou/enclave/src/attestation.ts still matches the RiskAttestation
// struct in sources/enclave.move. If those drift, every real signature
// silently stops verifying on-chain, and this test is the alarm.
const ENCLAVE_PUBKEY: vector<u8> =
    x"cd50a61933c82cb2725b54f515ece1f5c59406ef153e2be2ce317400de4cfca5";
const FIXTURE_SIGNATURE: vector<u8> =
    x"0651a8be63dc1017f47578747e9fe8f55bcda069a7c30efbfb3c2db1984dcb0d74161bca01054b68bb4d4871a1a8078d6904a98e3e49003036d9869aadb7750c";
const FIXTURE_TIMESTAMP_MS: u64 = 1700000000000;
const FIXTURE_MESSAGE_HASH: vector<u8> = x"00112233";
const FIXTURE_POLICY_ID: address = @0x00000000000000000000000000000000000000000000000000000000000000cc;
const FIXTURE_RECIPIENT: address = @0x00000000000000000000000000000000000000000000000000000000000000c1;
const FIXTURE_AMOUNT: u64 = 1000;
const FIXTURE_TIER: u8 = 2;
const FIXTURE_TRUTH_SCORE: u8 = 91;

/// Builds exactly the attestation the fixture was signed over.
fun fixture_attestation(): enclave::RiskAttestation {
    enclave::new_attestation(
        FIXTURE_TIMESTAMP_MS,
        FIXTURE_MESSAGE_HASH,
        FIXTURE_POLICY_ID.to_id(),
        FIXTURE_RECIPIENT,
        FIXTURE_AMOUNT,
        FIXTURE_TIER,
        FIXTURE_TRUTH_SCORE,
    )
}

/// The acceptance path: a genuine enclave signature verifies on-chain.
/// Every other enclave test proves something is *rejected*; without this
/// one they would all still pass if verification rejected everything.
#[test]
fun genuine_enclave_signature_verifies() {
    let mut scenario = test_scenario::begin(ADMIN);
    redflag::init_for_testing(scenario.ctx());
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FIXTURE_TIMESTAMP_MS);

    scenario.next_tx(ADMIN);
    let admin = scenario.take_from_sender<AdminCap>();
    let config = enclave::new_config(&admin, b"v1", x"aa", x"bb", x"cc", scenario.ctx());
    let enclave_obj = enclave::register_enclave(
        &config, &admin, ENCLAVE_PUBKEY, &clock, scenario.ctx(),
    );

    let attestation = fixture_attestation();
    enclave_obj.verify(&attestation, FIXTURE_SIGNATURE, &clock);
    assert_eq!(attestation.tier(), FIXTURE_TIER);
    assert_eq!(attestation.truth_score(), FIXTURE_TRUTH_SCORE);

    destroy(enclave_obj);
    destroy(config);
    scenario.return_to_sender(admin);
    clock.destroy_for_testing();
    scenario.end();
}

/// One flipped byte in the payload invalidates the signature — proving
/// the signature actually covers the transfer details, so a score cannot
/// be lifted from one payment and replayed against another.
#[test, expected_failure(abort_code = enclave::EInvalidSignature, location = enclave)]
fun tampered_amount_invalidates_the_signature() {
    let mut scenario = test_scenario::begin(ADMIN);
    redflag::init_for_testing(scenario.ctx());
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FIXTURE_TIMESTAMP_MS);

    scenario.next_tx(ADMIN);
    let admin = scenario.take_from_sender<AdminCap>();
    let config = enclave::new_config(&admin, b"v1", x"aa", x"bb", x"cc", scenario.ctx());
    let enclave_obj = enclave::register_enclave(
        &config, &admin, ENCLAVE_PUBKEY, &clock, scenario.ctx(),
    );

    // Same signature, larger amount.
    let tampered = enclave::new_attestation(
        FIXTURE_TIMESTAMP_MS,
        FIXTURE_MESSAGE_HASH,
        FIXTURE_POLICY_ID.to_id(),
        FIXTURE_RECIPIENT,
        FIXTURE_AMOUNT * 1000,
        FIXTURE_TIER,
        FIXTURE_TRUTH_SCORE,
    );
    enclave_obj.verify(&tampered, FIXTURE_SIGNATURE, &clock);

    destroy(enclave_obj);
    destroy(config);
    scenario.return_to_sender(admin);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun config_and_enclave_register_and_bind() {
    let mut scenario = test_scenario::begin(ADMIN);
    redflag::init_for_testing(scenario.ctx());
    let clock = clock::create_for_testing(scenario.ctx());

    scenario.next_tx(ADMIN);
    let admin = scenario.take_from_sender<AdminCap>();
    enclave::create_config(
        &admin,
        b"shou-risk-scorer-v1",
        x"aabb",
        x"ccdd",
        x"eeff",
        scenario.ctx(),
    );
    scenario.next_tx(ADMIN);

    let config = scenario.take_shared<EnclaveConfig>();
    enclave::create_enclave(&config, &admin, ENCLAVE_PUBKEY, &clock, scenario.ctx());
    scenario.next_tx(ADMIN);

    let enclave_obj = scenario.take_shared<Enclave>();
    assert!(enclave_obj.belongs_to(&config));
    assert_eq!(enclave_obj.public_key(), ENCLAVE_PUBKEY);
    enclave_obj.assert_belongs_to(&config);

    test_scenario::return_shared(config);
    test_scenario::return_shared(enclave_obj);
    scenario.return_to_sender(admin);
    clock.destroy_for_testing();
    scenario.end();
}

#[test, expected_failure(abort_code = enclave::EWrongEnclaveConfig, location = enclave)]
fun enclave_from_another_config_is_rejected() {
    let mut scenario = test_scenario::begin(ADMIN);
    redflag::init_for_testing(scenario.ctx());
    let clock = clock::create_for_testing(scenario.ctx());

    scenario.next_tx(ADMIN);
    let admin = scenario.take_from_sender<AdminCap>();
    let config_a = enclave::new_config(&admin, b"a", x"aa", x"bb", x"cc", scenario.ctx());
    let config_b = enclave::new_config(&admin, b"b", x"dd", x"ee", x"ff", scenario.ctx());

    // Registered against A, presented alongside B.
    let enclave_obj = enclave::register_enclave(
        &config_a, &admin, ENCLAVE_PUBKEY, &clock, scenario.ctx(),
    );
    enclave_obj.assert_belongs_to(&config_b);

    destroy(enclave_obj);
    destroy(config_a);
    destroy(config_b);
    scenario.return_to_sender(admin);
    clock.destroy_for_testing();
    scenario.end();
}

#[test, expected_failure(abort_code = enclave::EInvalidSignature, location = enclave)]
fun garbage_signature_is_rejected() {
    let mut scenario = test_scenario::begin(ADMIN);
    redflag::init_for_testing(scenario.ctx());
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.increment_for_testing(1_000_000);

    scenario.next_tx(ADMIN);
    let admin = scenario.take_from_sender<AdminCap>();
    let config = enclave::new_config(&admin, b"v1", x"aa", x"bb", x"cc", scenario.ctx());
    let enclave_obj = enclave::register_enclave(
        &config, &admin, ENCLAVE_PUBKEY, &clock, scenario.ctx(),
    );

    let attestation = enclave::new_attestation(
        clock.timestamp_ms(),
        x"00112233",
        object::id(&config),
        RECIPIENT,
        1_000,
        0,
        10,
    );
    // 64 zero bytes is a well-formed but invalid ed25519 signature.
    let bad_signature =
        x"0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
    enclave_obj.verify(&attestation, bad_signature, &clock);

    destroy(enclave_obj);
    destroy(config);
    scenario.return_to_sender(admin);
    clock.destroy_for_testing();
    scenario.end();
}

#[test, expected_failure(abort_code = enclave::EStaleAttestation, location = enclave)]
fun stale_attestation_is_rejected() {
    let mut scenario = test_scenario::begin(ADMIN);
    redflag::init_for_testing(scenario.ctx());
    let mut clock = clock::create_for_testing(scenario.ctx());

    scenario.next_tx(ADMIN);
    let admin = scenario.take_from_sender<AdminCap>();
    let config = enclave::new_config(&admin, b"v1", x"aa", x"bb", x"cc", scenario.ctx());
    let enclave_obj = enclave::register_enclave(
        &config, &admin, ENCLAVE_PUBKEY, &clock, scenario.ctx(),
    );

    // Scored now, submitted well after the freshness window. A score
    // describes a conversation happening at that moment; an old one says
    // nothing about the transfer in front of us.
    let attestation = enclave::new_attestation(
        clock.timestamp_ms(), x"00", object::id(&config), RECIPIENT, 1, 0, 0,
    );
    clock.increment_for_testing(enclave::freshness_window_ms() + 1);
    enclave_obj.verify(&attestation, x"00", &clock);

    destroy(enclave_obj);
    destroy(config);
    scenario.return_to_sender(admin);
    clock.destroy_for_testing();
    scenario.end();
}

#[test, expected_failure(abort_code = enclave::EAttestationFromFuture, location = enclave)]
fun future_dated_attestation_is_rejected() {
    let mut scenario = test_scenario::begin(ADMIN);
    redflag::init_for_testing(scenario.ctx());
    let clock = clock::create_for_testing(scenario.ctx());

    scenario.next_tx(ADMIN);
    let admin = scenario.take_from_sender<AdminCap>();
    let config = enclave::new_config(&admin, b"v1", x"aa", x"bb", x"cc", scenario.ctx());
    let enclave_obj = enclave::register_enclave(
        &config, &admin, ENCLAVE_PUBKEY, &clock, scenario.ctx(),
    );

    let attestation = enclave::new_attestation(
        clock.timestamp_ms() + 60_000, x"00", object::id(&config), RECIPIENT, 1, 0, 0,
    );
    enclave_obj.verify(&attestation, x"00", &clock);

    destroy(enclave_obj);
    destroy(config);
    scenario.return_to_sender(admin);
    clock.destroy_for_testing();
    scenario.end();
}

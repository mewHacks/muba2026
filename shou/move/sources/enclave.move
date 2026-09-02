/// SHOU TEE layer — Nautilus-pattern enclave attestation.
///
/// This is what makes shou-idea.md §9's privacy claim enforceable rather
/// than a promise. The elder's message text is decrypted and scored
/// *inside* an AWS Nitro Enclave; only a hash, a tier and a score ever
/// leave it. This module is the on-chain half: it holds the enclave's
/// registered public key and the PCR measurements of the code that key
/// belongs to, and verifies every signed score against them.
///
/// The trust chain (Nautilus design):
///   PCR0 = OS/boot, PCR1 = application code, PCR2 = runtime config.
///   Change one byte of the scoring code and the PCRs change, so a
///   swapped-in model or a backdoored scorer no longer matches what was
///   registered, and its signatures stop being accepted.
module shou::enclave;

use shou::redflag::AdminCap;
use sui::bcs;
use sui::clock::Clock;
use sui::ed25519;
use sui::event;

#[error]
const EInvalidSignature: vector<u8> = b"Risk attestation was not signed by the registered enclave";
#[error]
const EStaleAttestation: vector<u8> = b"Risk attestation is older than the freshness window";
#[error]
const EAttestationFromFuture: vector<u8> = b"Risk attestation timestamp is in the future";
#[error]
const EWrongEnclaveConfig: vector<u8> = b"Enclave does not belong to this config";

/// Domain separator. A signature over a risk score must never be
/// replayable as a signature over anything else this key might sign.
const INTENT_RISK_SCORE: u8 = 0;

/// How recent a score must be to be accepted on-chain. A score describes
/// a conversation happening *now*; an hour-old one says nothing about
/// the transfer in front of us.
const FRESHNESS_WINDOW_MS: u64 = 300_000; // 5 minutes

/// Sui's `Clock` advances per checkpoint, so it trails the enclave's
/// wall clock by a small and variable amount. Without an allowance here,
/// a correctly-signed attestation is rejected as "from the future"
/// purely because the chain has not caught up yet — which is exactly
/// what happened the first time this ran against testnet.
const CLOCK_SKEW_TOLERANCE_MS: u64 = 60_000; // 1 minute

/// The measurements of the code we expect to be running. Registered
/// once, from a build anyone can reproduce from the public repo.
public struct EnclaveConfig has key {
    id: UID,
    name: vector<u8>,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
}

/// A live enclave: the ephemeral public key generated inside it at
/// startup, bound to the config whose PCRs its attestation matched.
public struct Enclave has key {
    id: UID,
    config_id: ID,
    public_key: vector<u8>,
    registered_at_ms: u64,
}

/// Exactly the bytes the enclave signs. Every field is bound into the
/// signature so a score cannot be lifted from one transfer and replayed
/// against another — a score for "5 dollars to my grandson" must not
/// authorise "5000 dollars to a stranger".
public struct RiskAttestation has copy, drop {
    intent: u8,
    timestamp_ms: u64,
    /// sha256 of the scored message. The message itself never leaves the
    /// enclave — this is what makes the privacy claim checkable later
    /// without anyone having stored the conversation.
    message_hash: vector<u8>,
    policy_id: ID,
    recipient: address,
    amount: u64,
    risk_tier: u8,
    truth_score: u8,
}

public struct EnclaveConfigCreated has copy, drop { config_id: ID, name: vector<u8> }
public struct EnclaveRegistered has copy, drop {
    enclave_id: ID,
    config_id: ID,
    registered_at_ms: u64,
}

/// Registers the expected code measurements. Publish the enclave source,
/// let anyone reproduce the build, and these three hashes are what they
/// check their result against.
public fun new_config(
    _admin: &AdminCap,
    name: vector<u8>,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
    ctx: &mut TxContext,
): EnclaveConfig {
    EnclaveConfig { id: object::new(ctx), name, pcr0, pcr1, pcr2 }
}

entry fun create_config(
    admin: &AdminCap,
    name: vector<u8>,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
    ctx: &mut TxContext,
) {
    let config = new_config(admin, name, pcr0, pcr1, pcr2, ctx);
    event::emit(EnclaveConfigCreated { config_id: object::id(&config), name: config.name });
    transfer::share_object(config);
}

/// Binds a running enclave's ephemeral public key to a config.
///
/// PRODUCTION GAP, stated plainly: a complete Nautilus deployment passes
/// the raw AWS attestation document here and verifies its COSE signature
/// and certificate chain on-chain, which is what proves the key really
/// came out of an enclave running the code in `config`. That parsing
/// lives in Mysten's Nautilus Move library and is not reimplemented
/// here. Until it is wired in, registration is AdminCap-gated — the
/// signature checking below is fully real, but the *provenance* of the
/// registered key rests on the admin rather than on AWS's root of trust.
/// Do not describe this as a verified enclave until that swap is made.
public fun register_enclave(
    config: &EnclaveConfig,
    _admin: &AdminCap,
    public_key: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
): Enclave {
    Enclave {
        id: object::new(ctx),
        config_id: object::id(config),
        public_key,
        registered_at_ms: clock.timestamp_ms(),
    }
}

entry fun create_enclave(
    config: &EnclaveConfig,
    admin: &AdminCap,
    public_key: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let enclave = register_enclave(config, admin, public_key, clock, ctx);
    event::emit(EnclaveRegistered {
        enclave_id: object::id(&enclave),
        config_id: enclave.config_id,
        registered_at_ms: enclave.registered_at_ms,
    });
    transfer::share_object(enclave);
}

/// Builds the exact struct the enclave signed, so callers cannot reorder
/// or omit a field and still verify.
public fun new_attestation(
    timestamp_ms: u64,
    message_hash: vector<u8>,
    policy_id: ID,
    recipient: address,
    amount: u64,
    risk_tier: u8,
    truth_score: u8,
): RiskAttestation {
    RiskAttestation {
        intent: INTENT_RISK_SCORE,
        timestamp_ms,
        message_hash,
        policy_id,
        recipient,
        amount,
        risk_tier,
        truth_score,
    }
}

/// True only if this exact attestation was signed by this enclave's key
/// and is still fresh. Aborts rather than returning false on a bad
/// signature, so a caller cannot ignore the result by accident.
public fun verify(
    enclave: &Enclave,
    attestation: &RiskAttestation,
    signature: vector<u8>,
    clock: &Clock,
) {
    let now = clock.timestamp_ms();
    if (attestation.timestamp_ms > now) {
        assert!(
            attestation.timestamp_ms - now <= CLOCK_SKEW_TOLERANCE_MS,
            EAttestationFromFuture,
        );
    } else {
        assert!(now - attestation.timestamp_ms <= FRESHNESS_WINDOW_MS, EStaleAttestation);
    };

    let payload = bcs::to_bytes(attestation);
    assert!(
        ed25519::ed25519_verify(&signature, &enclave.public_key, &payload),
        EInvalidSignature,
    );
}

public fun tier(attestation: &RiskAttestation): u8 { attestation.risk_tier }

public fun policy_id(attestation: &RiskAttestation): ID { attestation.policy_id }

public fun recipient(attestation: &RiskAttestation): address { attestation.recipient }

public fun amount(attestation: &RiskAttestation): u64 { attestation.amount }

public fun timestamp_ms(attestation: &RiskAttestation): u64 { attestation.timestamp_ms }

public fun truth_score(attestation: &RiskAttestation): u8 { attestation.truth_score }

public fun message_hash(attestation: &RiskAttestation): vector<u8> { attestation.message_hash }

public fun config_id(enclave: &Enclave): ID { enclave.config_id }

public fun public_key(enclave: &Enclave): vector<u8> { enclave.public_key }

public fun belongs_to(enclave: &Enclave, config: &EnclaveConfig): bool {
    enclave.config_id == object::id(config)
}

public fun assert_belongs_to(enclave: &Enclave, config: &EnclaveConfig) {
    assert!(enclave.belongs_to(config), EWrongEnclaveConfig);
}

#[test_only]
public fun freshness_window_ms(): u64 { FRESHNESS_WINDOW_MS }

#[test_only]
public fun clock_skew_tolerance_ms(): u64 { CLOCK_SKEW_TOLERANCE_MS }

#[test_only]
public fun attestation_bytes(attestation: &RiskAttestation): vector<u8> {
    bcs::to_bytes(attestation)
}

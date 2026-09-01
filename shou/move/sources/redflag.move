/// SHOU Layer 3 — Red Flag reporting. Anyone can report a scammer's
/// address; Gonka Router scores the evidence off-chain (a plausibility
/// score, 0-100) and this module only enforces the resulting soft ban.
/// It never scores anything itself — see shou-idea.md §8, Flow C.
module shou::redflag;

use sui::clock::Clock;
use sui::event;
use sui::vec_map::{Self, VecMap};

#[error]
const ENotBanned: vector<u8> = b"Address is not currently banned";

/// Minted once to the package publisher at `init`. Required to mint any
/// further `StaffCap` — without this gate, anyone could mint themselves
/// a StaffCap and clear a scammer's own ban.
public struct AdminCap has key, store { id: UID }

public struct StaffCap has key, store { id: UID }

public struct BanEntry has store, drop {
    plausibility_score: u8,
    reported_at_ms: u64,
}

public struct DenyList has key {
    id: UID,
    banned: VecMap<address, BanEntry>,
}

public struct AddressBanned has copy, drop { addr: address, plausibility_score: u8 }
public struct AddressCleared has copy, drop { addr: address }

fun init(ctx: &mut TxContext) {
    transfer::transfer(AdminCap { id: object::new(ctx) }, ctx.sender());
}

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx);
}

public fun new_deny_list(ctx: &mut TxContext): DenyList {
    DenyList { id: object::new(ctx), banned: vec_map::empty() }
}

entry fun create_deny_list(ctx: &mut TxContext) {
    transfer::share_object(new_deny_list(ctx));
}

public fun new_staff_cap(_admin: &AdminCap, ctx: &mut TxContext): StaffCap {
    StaffCap { id: object::new(ctx) }
}

entry fun create_staff_cap(admin: &AdminCap, recipient: address, ctx: &mut TxContext) {
    transfer::transfer(new_staff_cap(admin, ctx), recipient);
}

/// Anyone can report — this is SHOU's Layer 3 landing on-chain.
/// `plausibility_score` is already computed off-chain by Gonka Router;
/// this function only enforces the resulting state. Re-reporting an
/// already-banned address refreshes the score and timestamp rather than
/// erroring, since repeat reports are corroborating evidence, not a bug.
entry fun report(list: &mut DenyList, addr: address, plausibility_score: u8, clock: &Clock) {
    let entry = BanEntry { plausibility_score, reported_at_ms: clock.timestamp_ms() };
    if (list.banned.contains(&addr)) {
        *list.banned.get_mut(&addr) = entry;
    } else {
        list.banned.insert(addr, entry);
    };
    event::emit(AddressBanned { addr, plausibility_score });
}

entry fun clear(list: &mut DenyList, _staff: &StaffCap, addr: address) {
    assert!(list.banned.contains(&addr), ENotBanned);
    let (_, _) = list.banned.remove(&addr);
    event::emit(AddressCleared { addr });
}

public fun is_banned(list: &DenyList, addr: address): bool {
    list.banned.contains(&addr)
}

public fun plausibility_score(list: &DenyList, addr: address): u8 {
    list.banned.get(&addr).plausibility_score
}

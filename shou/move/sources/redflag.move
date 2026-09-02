/// SHOU Layer 3 — Red Flag reporting. A scammer's address is reported,
/// Gonka Router scores the evidence off-chain (a plausibility score,
/// 0-100), and this module enforces the resulting soft ban. It never
/// scores anything itself — see shou-idea.md §8, Flow C.
module shou::redflag;

use sui::clock::Clock;
use sui::event;
use sui::table::{Self, Table};

#[error]
const ENotBanned: vector<u8> = b"Address is not currently banned";

/// Minted once to the package publisher at `init`. Required to mint any
/// other capability — without this gate, anyone could mint themselves a
/// StaffCap and clear a scammer's own ban.
public struct AdminCap has key, store { id: UID }

/// Held by staff who review the Red Flag queue and lift bad bans.
public struct StaffCap has key, store { id: UID }

/// Held by the Gonka scoring service. Reports reach the chain only after
/// that service has scored them — matching Flow C, where the AI scores
/// evidence *before* a ban lands. Without this gate anyone could ban any
/// address at will and cut off a legitimate merchant.
public struct OracleCap has key, store { id: UID }

public struct BanEntry has store, drop {
    plausibility_score: u8,
    reported_at_ms: u64,
    /// The "soft" in soft ban: transfers at or below this amount still go
    /// through, so a ban never cuts off someone's groceries while a
    /// reviewer works through the queue. 0 = block everything.
    ban_ceiling: u64,
}

/// `Table`, not `VecMap`: bans grow without bound and a VecMap would hit
/// Sui's 256KB object cap at a few thousand entries, after which no new
/// ban could be recorded at all.
public struct DenyList has key {
    id: UID,
    banned: Table<address, BanEntry>,
}

public struct AddressBanned has copy, drop {
    addr: address,
    plausibility_score: u8,
    ban_ceiling: u64,
}
public struct AddressCleared has copy, drop { addr: address }

fun init(ctx: &mut TxContext) {
    transfer::transfer(AdminCap { id: object::new(ctx) }, ctx.sender());
}

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx);
}

/// AdminCap-gated so there is exactly one canonical list. A policy binds
/// itself to a specific DenyList id at creation; see shou::policy.
public fun new_deny_list(_admin: &AdminCap, ctx: &mut TxContext): DenyList {
    DenyList { id: object::new(ctx), banned: table::new(ctx) }
}

entry fun create_deny_list(admin: &AdminCap, ctx: &mut TxContext) {
    transfer::share_object(new_deny_list(admin, ctx));
}

public fun new_staff_cap(_admin: &AdminCap, ctx: &mut TxContext): StaffCap {
    StaffCap { id: object::new(ctx) }
}

entry fun create_staff_cap(admin: &AdminCap, recipient: address, ctx: &mut TxContext) {
    transfer::transfer(new_staff_cap(admin, ctx), recipient);
}

public fun new_oracle_cap(_admin: &AdminCap, ctx: &mut TxContext): OracleCap {
    OracleCap { id: object::new(ctx) }
}

entry fun create_oracle_cap(admin: &AdminCap, recipient: address, ctx: &mut TxContext) {
    transfer::transfer(new_oracle_cap(admin, ctx), recipient);
}

/// Records a scored ban. `plausibility_score` and `ban_ceiling` are
/// decided off-chain by the Gonka scoring service; this only enforces the
/// result. Re-reporting an already-banned address refreshes it rather
/// than erroring — repeat reports are corroborating evidence, not a bug.
entry fun report(
    list: &mut DenyList,
    _oracle: &OracleCap,
    addr: address,
    plausibility_score: u8,
    ban_ceiling: u64,
    clock: &Clock,
) {
    let entry = BanEntry {
        plausibility_score,
        reported_at_ms: clock.timestamp_ms(),
        ban_ceiling,
    };
    if (list.banned.contains(addr)) {
        let _ = list.banned.remove(addr);
    };
    list.banned.add(addr, entry);
    event::emit(AddressBanned { addr, plausibility_score, ban_ceiling });
}

entry fun clear(list: &mut DenyList, _staff: &StaffCap, addr: address) {
    assert!(list.banned.contains(addr), ENotBanned);
    let _ = list.banned.remove(addr);
    event::emit(AddressCleared { addr });
}

public fun is_banned(list: &DenyList, addr: address): bool {
    list.banned.contains(addr)
}

/// The check `shou::policy` actually uses. A banned address still accepts
/// amounts at or below its ceiling, so the ban degrades service instead
/// of severing it.
public fun blocks_amount(list: &DenyList, addr: address, amount: u64): bool {
    if (!list.banned.contains(addr)) return false;
    amount > list.banned.borrow(addr).ban_ceiling
}

public fun plausibility_score(list: &DenyList, addr: address): u8 {
    assert!(list.banned.contains(addr), ENotBanned);
    list.banned.borrow(addr).plausibility_score
}

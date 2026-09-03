// Real implementation of ShouClient against the deployed shou::policy /
// shou::redflag Move package. Dev B never imports this file directly —
// only types.ts — so nothing here leaking a wrong assumption breaks the
// interface contract for the other side.
//
// The signer is injected, never read from disk here: in the demo app it
// comes from zkLogin + sponsored transactions, not a bare keypair file.

import { bcs } from '@mysten/sui/bcs';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';
import type { Signer } from '@mysten/sui/cryptography';

import type {
  EnclaveAttestation,
  PolicyView,
  RiskAssessment,
  RiskTier,
  ShouClient,
  TransferRequestView,
  TransferState,
  TransferStatus,
} from './types.js';

const RISK_TIER_CODE: Record<RiskTier, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
const RISK_TIER_NAME: RiskTier[] = ['LOW', 'MEDIUM', 'HIGH'];
const SUI_COIN_TYPE = '0x2::sui::SUI';

/**
 * Circle's USDC on Sui testnet. This is the coin SHOU is actually about:
 * the elder holds stablecoins her family sent her, not a volatile
 * native token. Faucet: https://faucet.circle.com (select Sui Testnet).
 * 6 decimals, so 1 USDC = 1_000_000.
 */
export const TESTNET_USDC =
  '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC';

const DEFAULT_GRPC_URL: Record<string, string> = {
  testnet: 'https://fullnode.testnet.sui.io:443',
  mainnet: 'https://fullnode.mainnet.sui.io:443',
  devnet: 'https://fullnode.devnet.sui.io:443',
  localnet: 'http://127.0.0.1:9000',
};

export interface ShouClientConfig {
  packageId: string;
  network?: 'testnet' | 'mainnet' | 'devnet' | 'localnet';
  /** Overrides the default full node for the chosen network. */
  baseUrl?: string;
  signer: Signer;
  /**
   * Required for reportRedFlag — the OracleCap object held by the Gonka
   * scoring service. Omit it on clients that only read or transact as the
   * elder; reportRedFlag will throw a clear error rather than a Move abort.
   */
  oracleCapId?: string;
}

function hexToBytes(hex: string): number[] {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) bytes.push(parseInt(clean.slice(i, i + 2), 16));
  return bytes;
}

/**
 * A Move `Balance<T>` decodes differently depending on the transport and
 * SDK version — sometimes `{ value: "1000000" }`, sometimes the bare
 * string. Guessing wrong here would show the guardian the wrong amount,
 * which is the one number they actually decide on, so handle both.
 */
function balanceValue(funds: unknown): string {
  if (funds === null || funds === undefined) return '0';
  if (typeof funds === 'string' || typeof funds === 'number') return String(funds);
  const value = (funds as { value?: unknown }).value;
  if (value === null || value === undefined) return '0';
  if (typeof value === 'object') return balanceValue(value);
  return String(value);
}

interface ChangedObject {
  objectId: string;
  idOperation?: string;
  objectType?: string | null;
}

interface ExecutedTransaction {
  digest: string;
  effects?: { changedObjects?: ChangedObject[] };
}

/**
 * gRPC effects report which objects were created but not their types
 * (objectType comes back absent even with include.objectTypes), so the
 * type has to be resolved with a follow-up read. Note idOperation is
 * PascalCase 'Created', not 'CREATED'.
 */
async function findCreatedObjectId(
  client: SuiGrpcClient,
  result: ExecutedTransaction,
  typeSuffix: string,
): Promise<string> {
  // On-chain types come back fully qualified: a generic parameter reads
  // as 0x0000...0002::sui::SUI, not 0x2::sui::SUI. Normalising both
  // sides keeps this working for any coin type, USDC included.
  // Compare only the part before the generic parameter. On-chain types
  // come back fully qualified (0x0000...0002::sui::SUI, not 0x2::sui::SUI),
  // so matching the whole string is brittle — and only one object of a
  // given struct is created per call anyway.
  const base = (t: string): string => t.split('<')[0]!;
  const wanted = base(typeSuffix);
  const matches = (candidate: string): boolean =>
    Boolean(candidate) && base(candidate).endsWith(wanted);

  const created = (result.effects?.changedObjects ?? []).filter(
    (change) => change.idOperation === 'Created',
  );
  for (const change of created) {
    if (matches(change.objectType ?? '')) return change.objectId;
  }
  for (const change of created) {
    const { object } = await client.getObject({ objectId: change.objectId });
    if (matches((object as { type?: string } | undefined)?.type ?? '')) return change.objectId;
  }
  throw new Error(`No created object matching "${typeSuffix}" in transaction ${result.digest}`);
}

export class SuiShouClient implements ShouClient {
  private readonly client: SuiGrpcClient;
  private readonly packageId: string;
  private readonly signer: Signer;
  private readonly oracleCapId?: string;

  constructor(config: ShouClientConfig) {
    const network = config.network ?? 'testnet';
    // JSON-RPC is deprecated on public full nodes and returns "Method not
    // found"; gRPC is the supported transport.
    this.client = new SuiGrpcClient({
      network,
      baseUrl: config.baseUrl ?? DEFAULT_GRPC_URL[network]!,
    });
    this.packageId = config.packageId;
    this.signer = config.signer;
    this.oracleCapId = config.oracleCapId;
  }

  /**
   * Move aborts surface as opaque RPC errors. These are money operations,
   * so surface the abort name (EWrongDenyList, EThresholdNotMet, ...)
   * that the contract actually raised rather than a generic failure.
   */
  private async execute(tx: Transaction, action: string): Promise<ExecutedTransaction> {
    try {
      const result = await this.client.signAndExecuteTransaction({
        signer: this.signer,
        transaction: tx,
        include: { effects: true, objectTypes: true },
      });
      if (result.$kind === 'FailedTransaction') {
        throw new Error(
          result.FailedTransaction.status.error?.message ?? 'transaction failed on-chain',
        );
      }
      await this.client.waitForTransaction({ digest: result.Transaction.digest });
      return result.Transaction as unknown as ExecutedTransaction;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`${action} failed: ${detail}`, { cause });
    }
  }

  async createPolicy(
    approvers: string[],
    threshold: number,
    cooldownMs: number,
    denyListId: string,
    reviewCeiling: number,
    highRiskCeiling: number,
  ): Promise<{ policyId: string }> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::policy::create_policy`,
      arguments: [
        tx.pure.vector('address', approvers),
        tx.pure.u8(threshold),
        tx.pure.u64(cooldownMs),
        tx.object(denyListId),
        tx.pure.u64(reviewCeiling),
        tx.pure.u64(highRiskCeiling),
      ],
    });
    const result = await this.execute(tx, 'createPolicy');
    return { policyId: await findCreatedObjectId(this.client, result, '::policy::SeniorityPolicy') };
  }

  async requestTransfer(
    policyId: string,
    denyListId: string,
    amount: number,
    recipient: string,
    risk: RiskAssessment,
    coinType: string = SUI_COIN_TYPE,
  ): Promise<{ requestId: string } & TransferState> {
    const tx = new Transaction();
    tx.setSender(this.signer.toSuiAddress());
    // Works for any coin type, stablecoins included: the SDK finds the
    // sender's coins of that type, merges and splits as needed. An
    // earlier version split from tx.gas, which silently only worked for
    // SUI — wrong for a product whose whole premise is stablecoins.
    const payment = coinWithBalance({ type: coinType, balance: BigInt(amount) });

    tx.moveCall({
      target: `${this.packageId}::policy::request_transfer`,
      typeArguments: [coinType],
      arguments: [
        tx.object(policyId),
        tx.object(denyListId),
        payment,
        tx.pure.address(recipient),
        tx.pure.u8(RISK_TIER_CODE[risk.tier]),
        tx.object.clock(),
      ],
    });
    const result = await this.execute(tx, 'requestTransfer');
    const requestId = await findCreatedObjectId(
      this.client,
      result,
      `::policy::TransferRequest<${coinType}>`,
    );
    return { requestId, ...(await this.getTransferStatus(requestId)) };
  }

  async registerEnclaveConfig(
    adminCapId: string,
    name: string,
    pcr0: string,
    pcr1: string,
    pcr2: string,
  ): Promise<{ configId: string }> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::enclave::create_config`,
      arguments: [
        tx.object(adminCapId),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(name))),
        tx.pure.vector('u8', hexToBytes(pcr0)),
        tx.pure.vector('u8', hexToBytes(pcr1)),
        tx.pure.vector('u8', hexToBytes(pcr2)),
      ],
    });
    const result = await this.execute(tx, 'registerEnclaveConfig');
    return { configId: await findCreatedObjectId(this.client, result, '::enclave::EnclaveConfig') };
  }

  async registerEnclave(
    configId: string,
    adminCapId: string,
    publicKeyHex: string,
  ): Promise<{ enclaveId: string }> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::enclave::create_enclave`,
      arguments: [
        tx.object(configId),
        tx.object(adminCapId),
        tx.pure.vector('u8', hexToBytes(publicKeyHex)),
        tx.object.clock(),
      ],
    });
    const result = await this.execute(tx, 'registerEnclave');
    return { enclaveId: await findCreatedObjectId(this.client, result, '::enclave::Enclave') };
  }

  async createDenyList(adminCapId: string): Promise<{ denyListId: string }> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::redflag::create_deny_list`,
      arguments: [tx.object(adminCapId)],
    });
    const result = await this.execute(tx, 'createDenyList');
    return { denyListId: await findCreatedObjectId(this.client, result, '::redflag::DenyList') };
  }

  async requestTransferAttested(
    policyId: string,
    denyListId: string,
    enclaveId: string,
    attestation: EnclaveAttestation,
    signatureHex: string,
    coinType: string = SUI_COIN_TYPE,
  ): Promise<{ requestId: string } & TransferState> {
    const tx = new Transaction();
    tx.setSender(this.signer.toSuiAddress());
    const amount = BigInt(attestation.amount);
    const payment = coinWithBalance({ type: coinType, balance: amount });

    // Rebuild the exact struct the enclave signed. Any drift here and the
    // on-chain ed25519 check fails, which is the intended behaviour.
    const attestationArg = tx.moveCall({
      target: `${this.packageId}::enclave::new_attestation`,
      arguments: [
        tx.pure.u64(attestation.timestampMs),
        tx.pure.vector('u8', hexToBytes(attestation.messageHash)),
        tx.pure.id(attestation.policyId),
        tx.pure.address(attestation.recipient),
        tx.pure.u64(amount),
        tx.pure.u8(attestation.riskTier),
        tx.pure.u8(attestation.truthScore),
      ],
    });

    tx.moveCall({
      target: `${this.packageId}::policy::request_transfer_attested`,
      typeArguments: [coinType],
      arguments: [
        tx.object(policyId),
        tx.object(denyListId),
        tx.object(enclaveId),
        attestationArg,
        tx.pure.vector('u8', hexToBytes(signatureHex)),
        payment,
        tx.pure.address(attestation.recipient),
        tx.object.clock(),
      ],
    });

    const result = await this.execute(tx, 'requestTransferAttested');
    const requestId = await findCreatedObjectId(
      this.client,
      result,
      `::policy::TransferRequest<${coinType}>`,
    );
    return { requestId, ...(await this.getTransferStatus(requestId)) };
  }

  async approveTransfer(
    requestId: string,
    policyId: string,
    coinType: string = SUI_COIN_TYPE,
  ): Promise<TransferState> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::policy::approve`,
      typeArguments: [coinType],
      arguments: [tx.object(requestId), tx.object(policyId)],
    });
    await this.execute(tx, 'approveTransfer');
    return this.getTransferStatus(requestId);
  }

  async blockTransfer(
    requestId: string,
    policyId: string,
    coinType: string = SUI_COIN_TYPE,
  ): Promise<TransferState> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::policy::block_and_refund`,
      typeArguments: [coinType],
      arguments: [tx.object(requestId), tx.object(policyId)],
    });
    await this.execute(tx, 'blockTransfer');
    return this.getTransferStatus(requestId);
  }

  async cancelTransfer(
    requestId: string,
    policyId: string,
    coinType: string = SUI_COIN_TYPE,
  ): Promise<TransferState> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::policy::cancel_and_refund`,
      typeArguments: [coinType],
      arguments: [tx.object(requestId), tx.object(policyId)],
    });
    await this.execute(tx, 'cancelTransfer');
    return this.getTransferStatus(requestId);
  }

  async executeTransfer(
    requestId: string,
    policyId: string,
    coinType: string = SUI_COIN_TYPE,
  ): Promise<TransferState> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::policy::execute_and_send`,
      typeArguments: [coinType],
      arguments: [tx.object(requestId), tx.object(policyId), tx.object.clock()],
    });
    await this.execute(tx, 'executeTransfer');
    return this.getTransferStatus(requestId);
  }

  async getTransferStatus(requestId: string): Promise<TransferState> {
    // `json` is the decoded Move struct; `content` is raw BCS bytes, so
    // asking for content alone gives you an unreadable byte array.
    const { object } = await this.client.getObject({
      objectId: requestId,
      include: { json: true },
    });
    const decoded = (object as { json?: unknown } | undefined)?.json;
    if (!decoded) {
      throw new Error(`TransferRequest ${requestId} not found or has no readable content`);
    }
    const fields = decoded as {
      approvals: string[];
      executed: boolean;
      blocked: boolean;
      risk_tier: number;
      unlock_at_ms: string;
    };

    const tier = RISK_TIER_NAME[Number(fields.risk_tier)] ?? 'LOW';
    const unlockAtMs = Number(fields.unlock_at_ms);
    const approvals = fields.approvals ?? [];

    let status: TransferStatus;
    if (fields.blocked) {
      status = 'BLOCKED';
    } else if (fields.executed) {
      status = 'EXECUTED';
    } else if (tier === 'HIGH') {
      // Threshold lives on the policy, not the request; the dashboard
      // compares against it. APPROVED here means "has at least one".
      status = approvals.length > 0 ? 'APPROVED' : 'NEEDS_APPROVAL';
    } else if (Date.now() < unlockAtMs) {
      status = 'AUTO_UNLOCK_SCHEDULED';
    } else {
      status = 'PENDING';
    }
    return { status, approvals, tier, unlockAtMs };
  }

  async getPolicy(policyId: string): Promise<PolicyView> {
    const { object } = await this.client.getObject({
      objectId: policyId,
      include: { json: true },
    });
    const decoded = (object as { json?: unknown } | undefined)?.json;
    if (!decoded) throw new Error(`SeniorityPolicy ${policyId} not found or has no readable content`);
    const fields = decoded as {
      owner: string;
      approvers: string[];
      threshold: number | string;
      cooldown_ms: string;
      review_ceiling: string;
      high_risk_ceiling: string;
      paused_until_ms: string;
    };
    return {
      policyId,
      owner: fields.owner,
      approvers: fields.approvers ?? [],
      threshold: Number(fields.threshold),
      cooldownMs: Number(fields.cooldown_ms),
      // Left as strings: both ceilings can legitimately be u64::MAX (the
      // documented way to opt out of amount escalation), which does not
      // survive a round trip through a JS number.
      reviewCeiling: String(fields.review_ceiling),
      highRiskCeiling: String(fields.high_risk_ceiling),
      pausedUntilMs: Number(fields.paused_until_ms),
    };
  }

  async listTransferRequests(policyId: string, limit = 25): Promise<TransferRequestView[]> {
    // A bare generic event type matches every instantiation on gRPC, so
    // this finds USDC and SUI requests alike without knowing the coin.
    const { events } = await this.client.listEvents({
      filter: { eventType: `${this.packageId}::policy::TransferRequested` },
      order: 'descending',
      limit,
    });

    const timestamps = new Map<string, number | null>();
    const rows: TransferRequestView[] = [];

    for (const event of events) {
      const json = (event.json ?? {}) as Record<string, unknown>;
      // gRPC decodes Move struct fields in snake_case; other transports
      // have used camelCase. Read both rather than depending on which
      // one this full node happens to be.
      const pick = (snake: string, camel: string): unknown => json[snake] ?? json[camel];
      const requestId = String(pick('request_id', 'requestId') ?? '');
      const eventPolicyId = String(pick('policy_id', 'policyId') ?? '');
      if (!requestId) continue;
      // The filter is per package, not per policy — one deployment can
      // guard several elders, and a guardian must not see another
      // family's transfers.
      if (eventPolicyId !== policyId) continue;

      // The event is only how we FIND the request. Its own fields are a
      // snapshot from creation time, so status comes from the object.
      let state: TransferState;
      let recipient = '';
      let amount = '0';
      try {
        const { object } = await this.client.getObject({
          objectId: requestId,
          include: { json: true },
        });
        const decoded = (object as { json?: unknown } | undefined)?.json as
          | { recipient?: string; funds?: unknown }
          | undefined;
        recipient = decoded?.recipient ?? '';
        amount = balanceValue(decoded?.funds);
        state = await this.getTransferStatus(requestId);
      } catch {
        // A request whose object has been deleted is not an error worth
        // failing the whole page over — skip the row.
        continue;
      }

      if (!timestamps.has(event.transactionDigest)) {
        try {
          // Same discriminated union as signAndExecuteTransaction returns.
          const result = await this.client.getTransaction({ digest: event.transactionDigest });
          timestamps.set(
            event.transactionDigest,
            result.$kind === 'Transaction' ? result.Transaction.timestampMs ?? null : null,
          );
        } catch {
          timestamps.set(event.transactionDigest, null);
        }
      }

      const claimed = pick('claimed_tier', 'claimedTier');
      const truth = pick('truth_score', 'truthScore');
      rows.push({
        requestId,
        policyId: eventPolicyId,
        recipient,
        amount,
        claimedTier: claimed === undefined || claimed === null ? null : RISK_TIER_NAME[Number(claimed)] ?? null,
        truthScore: truth === undefined || truth === null ? null : Number(truth),
        requestedAtMs: timestamps.get(event.transactionDigest) ?? null,
        requestedBy: event.sender,
        ...state,
      });
    }
    return rows;
  }

  async pause(policyId: string, untilMs: number): Promise<void> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::policy::pause`,
      arguments: [tx.object(policyId), tx.pure.u64(untilMs)],
    });
    await this.execute(tx, 'pause');
  }

  async unpause(policyId: string): Promise<void> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::policy::unpause`,
      arguments: [tx.object(policyId)],
    });
    await this.execute(tx, 'unpause');
  }

  async reportRedFlag(
    denyListId: string,
    address: string,
    plausibilityScore: number,
    banCeiling: number,
  ): Promise<{ banned: true }> {
    if (!this.oracleCapId) {
      throw new Error('reportRedFlag requires oracleCapId — only the scoring service can ban');
    }
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::redflag::report`,
      arguments: [
        tx.object(denyListId),
        tx.object(this.oracleCapId),
        tx.pure.address(address),
        tx.pure.u8(plausibilityScore),
        tx.pure.u64(banCeiling),
        tx.object.clock(),
      ],
    });
    await this.execute(tx, 'reportRedFlag');
    return { banned: true };
  }

  /** Total balance of `coinType` held by `owner`, in base units. */
  async balanceOf(owner: string, coinType: string = SUI_COIN_TYPE): Promise<bigint> {
    const { balance } = await this.client.getBalance({ owner, coinType });
    return BigInt((balance as { balance?: string })?.balance ?? 0);
  }

  async isAmountBlocked(denyListId: string, address: string, amount: number): Promise<boolean> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::redflag::blocks_amount`,
      arguments: [tx.object(denyListId), tx.pure.address(address), tx.pure.u64(amount)],
    });
    tx.setSender(this.signer.toSuiAddress());
    const result = await this.client.simulateTransaction({
      transaction: tx,
      checksEnabled: false,
      include: { commandResults: true },
    });
    const bytes = (
      result as unknown as {
        commandResults?: { returnValues?: { value?: Uint8Array }[] }[];
      }
    ).commandResults?.[0]?.returnValues?.[0]?.value;
    if (!bytes) {
      throw new Error(
        'blocks_amount simulate returned no value',
      );
    }
    return bcs.bool().parse(new Uint8Array(bytes));
  }
}

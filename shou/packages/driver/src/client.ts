// Real implementation of ShouClient against the deployed shou::policy /
// shou::redflag Move package. Dev B never imports this file directly —
// only types.ts — so nothing here leaking a wrong assumption breaks the
// interface contract for the other side.
//
// The signer is injected, never read from disk here: in the demo app it
// comes from zkLogin + sponsored transactions, not a bare keypair file.

import { bcs } from '@mysten/sui/bcs';
import { SuiClient, getFullnodeUrl, type SuiTransactionBlockResponse } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import type { Signer } from '@mysten/sui/cryptography';

import type {
  RiskAssessment,
  RiskTier,
  ShouClient,
  TransferState,
  TransferStatus,
} from './types.js';

const RISK_TIER_CODE: Record<RiskTier, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
const RISK_TIER_NAME: RiskTier[] = ['LOW', 'MEDIUM', 'HIGH'];
const SUI_COIN_TYPE = '0x2::sui::SUI';

export interface ShouClientConfig {
  packageId: string;
  network?: 'testnet' | 'mainnet' | 'devnet' | 'localnet';
  signer: Signer;
  /**
   * Required for reportRedFlag — the OracleCap object held by the Gonka
   * scoring service. Omit it on clients that only read or transact as the
   * elder; reportRedFlag will throw a clear error rather than a Move abort.
   */
  oracleCapId?: string;
}

function findCreatedObjectId(result: SuiTransactionBlockResponse, typeSuffix: string): string {
  const created = result.objectChanges?.find(
    (change) => change.type === 'created' && change.objectType.endsWith(typeSuffix),
  );
  if (!created || created.type !== 'created') {
    throw new Error(`No created object matching "${typeSuffix}" in transaction ${result.digest}`);
  }
  return created.objectId;
}

export class SuiShouClient implements ShouClient {
  private readonly client: SuiClient;
  private readonly packageId: string;
  private readonly signer: Signer;
  private readonly oracleCapId?: string;

  constructor(config: ShouClientConfig) {
    this.client = new SuiClient({ url: getFullnodeUrl(config.network ?? 'testnet') });
    this.packageId = config.packageId;
    this.signer = config.signer;
    this.oracleCapId = config.oracleCapId;
  }

  /**
   * Move aborts surface as opaque RPC errors. These are money operations,
   * so surface the abort name (EWrongDenyList, EThresholdNotMet, ...)
   * that the contract actually raised rather than a generic failure.
   */
  private async execute(tx: Transaction, action: string): Promise<SuiTransactionBlockResponse> {
    try {
      const result = await this.client.signAndExecuteTransaction({
        signer: this.signer,
        transaction: tx,
        options: { showEffects: true, showObjectChanges: true },
      });
      await this.client.waitForTransaction({ digest: result.digest });
      if (result.effects?.status.status === 'failure') {
        throw new Error(`${action} failed on-chain: ${result.effects.status.error ?? 'unknown'}`);
      }
      return result;
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
    return { policyId: findCreatedObjectId(result, '::policy::SeniorityPolicy') };
  }

  async requestTransfer(
    policyId: string,
    denyListId: string,
    amount: number,
    recipient: string,
    risk: RiskAssessment,
    coinType: string = SUI_COIN_TYPE,
    paymentCoinIds?: string[],
  ): Promise<{ requestId: string } & TransferState> {
    const tx = new Transaction();

    // The payment must be a Coin<coinType>. Splitting from tx.gas only
    // works when coinType IS SUI, since the gas coin is always SUI — for
    // a stablecoin the caller must supply coins of that type.
    let payment;
    if (coinType === SUI_COIN_TYPE) {
      [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
    } else {
      if (!paymentCoinIds || paymentCoinIds.length === 0) {
        throw new Error(
          `requestTransfer for ${coinType} requires paymentCoinIds — only SUI can be split from gas`,
        );
      }
      const [primary, ...rest] = paymentCoinIds;
      const primaryCoin = tx.object(primary!);
      if (rest.length > 0) tx.mergeCoins(primaryCoin, rest.map((id) => tx.object(id)));
      [payment] = tx.splitCoins(primaryCoin, [tx.pure.u64(amount)]);
    }

    tx.moveCall({
      target: `${this.packageId}::policy::request_transfer`,
      typeArguments: [coinType],
      arguments: [
        tx.object(policyId),
        tx.object(denyListId),
        payment!,
        tx.pure.address(recipient),
        tx.pure.u8(RISK_TIER_CODE[risk.tier]),
        tx.object.clock(),
      ],
    });
    const result = await this.execute(tx, 'requestTransfer');
    const requestId = findCreatedObjectId(result, `::policy::TransferRequest<${coinType}>`);
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
    const obj = await this.client.getObject({ id: requestId, options: { showContent: true } });
    if (obj.data?.content?.dataType !== 'moveObject') {
      throw new Error(`TransferRequest ${requestId} not found or has no readable content`);
    }
    const fields = obj.data.content.fields as unknown as {
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

  async isAmountBlocked(denyListId: string, address: string, amount: number): Promise<boolean> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::redflag::blocks_amount`,
      arguments: [tx.object(denyListId), tx.pure.address(address), tx.pure.u64(amount)],
    });
    const result = await this.client.devInspectTransactionBlock({
      sender: this.signer.toSuiAddress(),
      transactionBlock: tx,
    });
    const bytes = result.results?.[0]?.returnValues?.[0]?.[0];
    if (!bytes) {
      throw new Error(
        `blocks_amount dev-inspect returned no value: ${JSON.stringify(result.effects?.status)}`,
      );
    }
    return bcs.bool().parse(new Uint8Array(bytes));
  }
}

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

import type { RiskAssessment, RiskTier, ShouClient, TransferStatus } from './types.js';

const RISK_TIER_CODE: Record<RiskTier, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
const SUI_COIN_TYPE = '0x2::sui::SUI';

export interface ShouClientConfig {
  packageId: string;
  network?: 'testnet' | 'mainnet' | 'devnet' | 'localnet';
  signer: Signer;
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

  constructor(config: ShouClientConfig) {
    this.client = new SuiClient({ url: getFullnodeUrl(config.network ?? 'testnet') });
    this.packageId = config.packageId;
    this.signer = config.signer;
  }

  private async execute(tx: Transaction): Promise<SuiTransactionBlockResponse> {
    const result = await this.client.signAndExecuteTransaction({
      signer: this.signer,
      transaction: tx,
      options: { showEffects: true, showObjectChanges: true },
    });
    await this.client.waitForTransaction({ digest: result.digest });
    return result;
  }

  async createPolicy(
    approvers: string[],
    threshold: number,
    cooldownMs: number,
  ): Promise<{ policyId: string }> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::policy::create_policy`,
      arguments: [
        tx.pure.vector('address', approvers),
        tx.pure.u8(threshold),
        tx.pure.u64(cooldownMs),
      ],
    });
    const result = await this.execute(tx);
    return { policyId: findCreatedObjectId(result, '::policy::SeniorityPolicy') };
  }

  async createGuard(policyId: string): Promise<{ guardId: string }> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::policy::create_guard`,
      arguments: [tx.object(policyId)],
    });
    const result = await this.execute(tx);
    return { guardId: findCreatedObjectId(result, '::policy::WalletGuard') };
  }

  async requestTransfer(
    policyId: string,
    guardId: string,
    denyListId: string,
    amount: number,
    recipient: string,
    risk: RiskAssessment,
    coinType: string = SUI_COIN_TYPE,
  ): Promise<{ requestId: string; tier: RiskTier; unlockAtMs: number; status: TransferStatus }> {
    const tx = new Transaction();
    const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
    tx.moveCall({
      target: `${this.packageId}::policy::request_transfer`,
      typeArguments: [coinType],
      arguments: [
        tx.object(policyId),
        tx.object(guardId),
        tx.object(denyListId),
        payment,
        tx.pure.address(recipient),
        tx.pure.u8(RISK_TIER_CODE[risk.tier]),
        tx.object.clock(),
      ],
    });
    const result = await this.execute(tx);
    const requestId = findCreatedObjectId(result, `::policy::TransferRequest<${coinType}>`);
    const status = await this.getTransferStatus(requestId);
    return { requestId, tier: risk.tier, unlockAtMs: 0, status: status.status };
  }

  async approveTransfer(
    requestId: string,
    policyId: string,
    _approver: string,
    coinType: string = SUI_COIN_TYPE,
  ): Promise<{ status: TransferStatus }> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::policy::approve`,
      typeArguments: [coinType],
      arguments: [tx.object(requestId), tx.object(policyId)],
    });
    await this.execute(tx);
    return this.getTransferStatus(requestId);
  }

  async blockTransfer(
    requestId: string,
    policyId: string,
    _approver: string,
    coinType: string = SUI_COIN_TYPE,
  ): Promise<{ status: TransferStatus }> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::policy::block_and_refund`,
      typeArguments: [coinType],
      arguments: [tx.object(requestId), tx.object(policyId)],
    });
    await this.execute(tx);
    return this.getTransferStatus(requestId);
  }

  async executeTransfer(
    requestId: string,
    policyId: string,
    coinType: string = SUI_COIN_TYPE,
  ): Promise<{ status: TransferStatus }> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::policy::execute_and_send`,
      typeArguments: [coinType],
      arguments: [tx.object(requestId), tx.object(policyId), tx.object.clock()],
    });
    await this.execute(tx);
    return this.getTransferStatus(requestId);
  }

  async getTransferStatus(requestId: string): Promise<{ status: TransferStatus; approvals: string[] }> {
    const obj = await this.client.getObject({ id: requestId, options: { showContent: true } });
    if (obj.data?.content?.dataType !== 'moveObject') {
      throw new Error(`TransferRequest ${requestId} not found or has no readable content`);
    }
    const fields = obj.data.content.fields as {
      approvals: string[];
      executed: boolean;
      blocked: boolean;
    };
    let status: TransferStatus;
    if (fields.blocked) status = 'BLOCKED_BY_GUARDIAN';
    else if (fields.executed) status = 'EXECUTED';
    else if (fields.approvals.length > 0) status = 'NEEDS_APPROVAL';
    else status = 'PENDING';
    return { status, approvals: fields.approvals };
  }

  async reportRedFlag(
    denyListId: string,
    address: string,
    plausibilityScore: number,
  ): Promise<{ banned: true }> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::redflag::report`,
      arguments: [
        tx.object(denyListId),
        tx.pure.address(address),
        tx.pure.u8(plausibilityScore),
        tx.object.clock(),
      ],
    });
    await this.execute(tx);
    return { banned: true };
  }

  async isRecipientBanned(denyListId: string, address: string): Promise<boolean> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::redflag::is_banned`,
      arguments: [tx.object(denyListId), tx.pure.address(address)],
    });
    const result = await this.client.devInspectTransactionBlock({
      sender: this.signer.toSuiAddress(),
      transactionBlock: tx,
    });
    const bytes = result.results?.[0]?.returnValues?.[0]?.[0];
    if (!bytes) {
      throw new Error(`is_banned dev-inspect returned no value: ${JSON.stringify(result.effects?.status)}`);
    }
    return bcs.bool().parse(new Uint8Array(bytes));
  }
}

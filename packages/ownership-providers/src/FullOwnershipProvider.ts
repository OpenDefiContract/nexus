import { BIish, BI } from '@ckb-lumos/bi';
import isEqual from 'lodash.isequal';
import {
  createTransactionFromSkeleton,
  minimalCellCapacityCompatible,
  parseAddress,
  TransactionSkeletonType,
} from '@ckb-lumos/helpers';
import { Events, FullOwnership, InjectedCkb } from '@nexus-wallet/protocol';
import { errors } from '@nexus-wallet/utils';
import { Address, blockchain, Cell, Script, Transaction } from '@ckb-lumos/base';
import { config } from '@ckb-lumos/lumos';
import { WitnessArgs } from '@ckb-lumos/base/lib/blockchain';
import { bytes } from '@ckb-lumos/codec';
import { prepareSigningEntries } from '@ckb-lumos/common-scripts/lib/secp256k1_blake160';
import { Config as LumosConfig } from '@ckb-lumos/config-manager/lib';
// util types for FullOwnership

type Suffix<T extends string, P extends string> = T extends `${P}${infer S}` ? S : never;
type FullOwnershipPrefix = 'wallet_fullOwnership_';
type OwnershipMethodNames = Suffix<keyof FullOwnership, FullOwnershipPrefix>;
type ParamOf<K extends OwnershipMethodNames> = Parameters<FullOwnership[`${FullOwnershipPrefix}${K}`]>[0];
type ReturnOf<K extends OwnershipMethodNames> = ReturnType<FullOwnership[`${FullOwnershipPrefix}${K}`]>;

/** Must be a full format address if it's an address */
export type LockScriptLike = Address | Script;

export type PayFeeOptions = {
  /**
   * The fee rate, in Shannons per byte. If not specified, the fee rate will be calculated automatically.
   */
  feeRate?: BIish;
} & PayBy;
export type PayBy = PayByPayers | PayByAuto;
/** Pay by the specified payers */
export type PayByPayers = { payers: LockScriptLike[]; autoInject?: boolean };
/** Pay by inject automatically */
export type PayByAuto = { autoInject: true };

function getTransactionSizeByTx(tx: Transaction): number {
  const serializedTx = blockchain.Transaction.pack(tx);
  // 4 is serialized offset bytesize
  const size = serializedTx.byteLength + 4;
  return size;
}
function calculateFeeCompatible(size: number, feeRate: BIish): BI {
  const ratio = BI.from(1000);
  const base = BI.from(size).mul(feeRate);
  const fee = base.div(ratio);
  if (fee.mul(ratio).lt(base)) {
    return fee.add(1);
  }
  return BI.from(fee);
}

const lockToScript = (addr: LockScriptLike): Script => {
  if (typeof addr === 'object') {
    return addr;
  }
  const networkConfig = addr.startsWith('ckt') ? config.predefined.AGGRON4 : config.predefined.LINA;
  // FIXME: it is not a good way to determine the network
  return parseAddress(addr, { config: networkConfig });
};

type FullOwnershipProviderConfig = {
  ckb: InjectedCkb<FullOwnership, Events>;
};

export class FullOwnershipProvider {
  private ckb: InjectedCkb<FullOwnership, Events>;

  constructor(config: FullOwnershipProviderConfig) {
    this.ckb = config.ckb;
  }

  async getLiveCells(params?: ParamOf<'getLiveCells'>): ReturnOf<'getLiveCells'> {
    return this.ckb.request({ method: 'wallet_fullOwnership_getLiveCells', params });
  }

  async getOffChainLocks(params: ParamOf<'getOffChainLocks'>): ReturnOf<'getOffChainLocks'> {
    return this.ckb.request({ method: 'wallet_fullOwnership_getOffChainLocks', params });
  }

  async getOnChainLocks(params: ParamOf<'getOnChainLocks'>): ReturnOf<'getOnChainLocks'> {
    return this.ckb.request({ method: 'wallet_fullOwnership_getOnChainLocks', params });
  }

  // TODO bind other methods, getOffChainLocks, getOnChainLocks, etc.

  /**
   * Inject capacity to the transaction's inputs at least equal to the `amount`,
   * if the collected capacity is over the `amount`, a change cell will be added to the transaction's outputs.
   * @example
   *   // Transfer 100 CKB to the target lock script
   *   declare let txSkeleton: TransactionSkeletonType;
   *   declare const target: Script;
   *   declare const provider: FullOwnershipProvider;
   *   const capacity = '10000000000'; // 100 CKB
   *   txSkeleton = txSkeleton.update('outputs', (outputs) =>
   *     outputs.push({ cellOutput: { capacity: capacity, lock: target }, data: '0x' }),
   *   );
   *
   *   txSkeleton = await provider.injectCapacity(txSkeleton, { amount: capacity });
   *
   * @param txSkeleton
   * @param config
   */
  async injectCapacity(
    txSkeleton: TransactionSkeletonType,
    config: {
      /** Inject at least this amount of capacity */
      amount: BIish;
      lock?: LockScriptLike;
    },
  ): Promise<TransactionSkeletonType> {
    const changeLock = (await this.getOffChainLocks({ change: 'internal' }))[0];

    const changeCell: Cell = {
      cellOutput: {
        capacity: '0x0',
        lock: changeLock,
      },
      data: '0x',
    };
    const minimalChangeCapacity = minimalCellCapacityCompatible(changeCell);

    if (!changeLock) {
      errors.throwError('No change lock script found, it may be a internal bug');
    }

    let remainCapacity = BI.from(config.amount).add(minimalChangeCapacity);
    const inputCells: Cell[] = [];
    const payerLock = config.lock ? lockToScript(config.lock) : undefined;

    for await (const cell of this.collector({ lock: payerLock })) {
      inputCells.push(cell);
      remainCapacity = remainCapacity.sub(BI.from(cell.cellOutput.capacity));
      if (remainCapacity.lte(0)) {
        break;
      }
    }
    if (remainCapacity.gt(0)) {
      errors.throwError('No cell sufficient to inject');
    }

    const totalInputs = inputCells.reduce((sum, cell) => sum.add(BI.from(cell.cellOutput.capacity)), BI.from(0));
    const changeAmount = totalInputs.sub(BI.from(config.amount));

    changeCell.cellOutput.capacity = changeAmount.toHexString();

    txSkeleton = txSkeleton
      .update('inputs', (inputs) => {
        return inputs.push(...inputCells);
      })
      .update('outputs', (outputs) => {
        return outputs.push(changeCell);
      });

    return txSkeleton;
  }

  /**
   * Pay the transaction fee
   * @param txSkeleton
   * @param options
   */
  async payFee({
    txSkeleton,
    options = { autoInject: true },
  }: {
    txSkeleton: TransactionSkeletonType;
    options?: PayFeeOptions;
  }): Promise<TransactionSkeletonType> {
    if ('payers' in options && options.payers.length === 0 && !options.autoInject) {
      errors.throwError('no payer is provided, but autoInject is `false`');
    }

    let size = 0;
    let txSkeletonWithFee = txSkeleton;
    const autoInject = !!options.autoInject;
    const payers = 'payers' in options ? options.payers : [];
    const feeRate = BI.from(options.feeRate || 1000);
    let currentTransactionSize = getTransactionSizeByTx(createTransactionFromSkeleton(txSkeleton));

    while (currentTransactionSize > size) {
      size = currentTransactionSize;
      const fee = calculateFeeCompatible(size, feeRate);

      let injected = false;
      for (const payer of payers) {
        try {
          txSkeletonWithFee = await this.injectCapacity(txSkeleton, { lock: payer, amount: fee });
          injected = true;
          break;
        } catch {}
      }

      if (!injected && autoInject) {
        txSkeletonWithFee = await this.injectCapacity(txSkeleton, {
          amount: fee,
        });
        injected = true;
      }

      if (!injected) {
        errors.throwError(autoInject ? 'No cell sufficient to pay fee' : 'No payer available to pay fee');
      }
      currentTransactionSize = getTransactionSizeByTx(createTransactionFromSkeleton(txSkeletonWithFee));
    }

    return txSkeletonWithFee;
  }

  async *collector({ lock }: { lock?: Script } = {}): AsyncIterable<Cell> {
    let cursor = '';
    while (true) {
      const page = await this.getLiveCells({ cursor });
      if (page.objects.length === 0) {
        return;
      }
      cursor = page.cursor;
      for (const cell of page.objects) {
        if (!lock || isEqual(lock, cell.cellOutput.lock)) {
          yield cell;
        }
      }
    }
  }

  /**
   * request wallet to sign a transaction skeleton
   * @param txSkeleton The transaction skeleton, you can create it from transaction object via `@ckb-lumos` {@link createTransactionFromSkeleton}
   * @returns The signed transaction skeleton. To get the signed transaction object, please use {@link sealTransaction} with empty sealingContents(`[ ]`).
   */
  async signTransaction(txSkeleton: TransactionSkeletonType): Promise<TransactionSkeletonType> {
    const config = await this.getLumosConfig();
    prepareSigningEntries(txSkeleton, { config });
    const groupedSignature = await this.ckb.request({
      method: 'wallet_fullOwnership_signTransaction',
      params: { tx: createTransactionFromSkeleton(txSkeleton) },
    });

    txSkeleton = txSkeleton.update('witnesses', (witnesses) => {
      return witnesses.map((witness, index) => {
        const [, signature] = groupedSignature[index];
        if (!signature) return witness;
        const witnessArgs = WitnessArgs.unpack(witness);
        return bytes.hexify(
          WitnessArgs.pack({
            ...witnessArgs,
            lock: signature,
          }),
        );
      });
    });

    txSkeleton = txSkeleton.update('signingEntries', (signingEntries) =>
      signingEntries.splice(0, groupedSignature.length),
    );

    return txSkeleton;
  }

  // TODO: wait for wallet provide a API to get genius block hash
  private async getLumosConfig(): Promise<LumosConfig> {
    errors.unimplemented();
  }
}

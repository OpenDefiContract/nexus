import { Address, blockchain, Cell, HexString, Script, Transaction } from '@ckb-lumos/base';
import { BI, BIish } from '@ckb-lumos/bi';
import { bytes } from '@ckb-lumos/codec';
import { PackParam, Uint8ArrayCodec } from '@ckb-lumos/codec/lib/base';
import { createTransactionFromSkeleton, TransactionSkeletonType } from '@ckb-lumos/helpers';

export function equalPack<C extends Uint8ArrayCodec>(codec: C, a: PackParam<C>, b: PackParam<C>): boolean {
  return bytes.equal(codec.pack(a), codec.pack(b));
}

export const WITNESS_LOCK_PLACEHOLDER = bytes.hexify(new Uint8Array(65));

export const SECP256K1_BLAKE160_WITNESS_PLACEHOLDER = bytes.hexify(
  blockchain.WitnessArgs.pack({
    lock: WITNESS_LOCK_PLACEHOLDER,
  }),
);

/** Must be a full format address if it's an address */
export type LockScriptLike = Address | Script;

// TODO: let lumos export `getTransactionSizeByTx` and `calculateFeeCompatible` and `lockToScript`
/* istanbul ignore next */
export function getTransactionSizeByTx(tx: Transaction): number {
  const serializedTx = blockchain.Transaction.pack(tx);
  // 4 is serialized offset bytesize
  const size = serializedTx.byteLength + 4;
  return size;
}

/* istanbul ignore next */
export function calculateFeeCompatible(size: number, feeRate: BIish): BI {
  const ratio = BI.from(1000);
  const base = BI.from(size).mul(feeRate);
  const fee = base.div(ratio);
  if (fee.mul(ratio).lt(base)) {
    return fee.add(1);
  }
  return BI.from(fee);
}

export function sumCapacity(cells: TransactionSkeletonType['inputs' | 'outputs']): BI {
  return cells.reduce((prev, cur) => prev.add(cur.cellOutput.capacity), BI.from(0));
}

export function hexifyScript<C extends Uint8ArrayCodec>(value: PackParam<C>): HexString {
  return bytes.hexify(blockchain.Script.pack(value));
}

export function isLockOnlyCell(cell: Cell): boolean {
  return !cell.cellOutput.type && cell.data === '0x';
}

export function isTransactionFeePaid(txSkeleton: TransactionSkeletonType, feeRate: BIish = 1000): boolean {
  // TODO: support DAO
  const txSize = getTransactionSizeByTx(createTransactionFromSkeleton(txSkeleton));
  const expectedFee = calculateFeeCompatible(txSize, feeRate);
  const actualFee = sumCapacity(txSkeleton.get('inputs')).sub(sumCapacity(txSkeleton.get('outputs')));

  return actualFee.gte(expectedFee);
}

export class ScriptSerializedMap<V> extends Map<string, V> {
  constructor(values: [Script, V][] = []) {
    super(values.map(([key, value]) => [hexifyScript(key), value]));
  }
  private hashKey(key: Script | string): string {
    return typeof key === 'string' ? key : hexifyScript(key);
  }

  get(key: Script | string): V | undefined {
    return super.get(this.hashKey(key));
  }

  set(key: Script | string, value: V): this {
    return super.set(this.hashKey(key), value);
  }

  has(key: Script | string): boolean {
    return super.has(this.hashKey(key));
  }

  delete(key: string | Script): boolean {
    return super.delete(this.hashKey(key));
  }
}

export class ScriptSerializedSet extends Set<string> {
  constructor(values: Script[] = []) {
    super(values.map(hexifyScript));
  }

  private hashKey(key: Script | string): string {
    return typeof key === 'string' ? key : hexifyScript(key);
  }

  add(key: Script | string): this {
    return super.add(this.hashKey(key));
  }

  has(key: Script | string): boolean {
    return super.has(this.hashKey(key));
  }

  delete(key: Script | string): boolean {
    return super.delete(this.hashKey(key));
  }
}

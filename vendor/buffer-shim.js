// wasm-zstd's wrapper is written for Node and reaches for Buffer. This is the
// two-method subset it actually uses, over plain typed arrays.
class Buf extends Uint8Array {
  copy(target, targetStart = 0, srcStart = 0, srcEnd = this.length) {
    target.set(this.subarray(srcStart, srcEnd), targetStart);
    return srcEnd - srcStart;
  }
}
export const Buffer = {
  allocUnsafe: (n) => new Buf(n),
  alloc: (n) => new Buf(n),
  from: (x, o, l) => (x instanceof ArrayBuffer ? new Buf(x, o, l) : new Buf(x)),
  isBuffer: (x) => x instanceof Uint8Array,
};

function starts(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}
/** Bounded consistency guard only; file decoding remains an adapter responsibility. */
export function binarySignature(bytes: Uint8Array): boolean {
  const prefix = String.fromCharCode(...bytes.subarray(0, 1024));
  if (prefix.includes("%PDF-")) return true;
  if (
    starts(bytes, [137, 80, 78, 71, 13, 10, 26, 10]) ||
    starts(bytes, [255, 216, 255]) ||
    starts(bytes, [71, 73, 70, 56]) ||
    starts(bytes, [31, 139]) ||
    starts(bytes, [127, 69, 76, 70]) ||
    starts(bytes, [73, 73, 42, 0]) ||
    starts(bytes, [77, 77, 0, 42])
  )
    return true;
  if (
    starts(bytes, [80, 75]) &&
    ((bytes[2] === 3 && bytes[3] === 4) ||
      (bytes[2] === 5 && bytes[3] === 6) ||
      (bytes[2] === 7 && bytes[3] === 8))
  )
    return true;
  if (
    starts(bytes, [82, 73, 70, 70]) &&
    starts(bytes.subarray(8), [87, 69, 66, 80])
  )
    return true;
  if (bytes.length >= 64 && starts(bytes, [77, 90])) {
    const pointer = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).getUint32(60, true);
    if (
      pointer <= bytes.length - 4 &&
      starts(bytes.subarray(pointer), [80, 69, 0, 0])
    )
      return true;
  }
  return false;
}

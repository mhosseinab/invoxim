export function roundRatio(numerator: bigint, denominator: bigint): bigint {
  const sign = numerator < 0n ? -1n : 1n;
  const n = numerator < 0n ? -numerator : numerator;
  return sign * ((n + denominator / 2n) / denominator);
}
export function convertMinor(
  minor: bigint,
  from: number,
  to: number,
  rate: string,
): bigint {
  if (
    ![0, 2, 3].includes(from) ||
    ![0, 2, 3].includes(to) ||
    !/^(0|[1-9][0-9]{0,12})(\.[0-9]{1,18})?$/.test(rate)
  )
    throw new Error("INVALID_FX_RATE");
  const [whole, fraction = ""] = rate.split(".");
  if (whole === undefined) throw new Error("INVALID_FX_RATE");
  const numerator = BigInt(whole + fraction);
  if (numerator === 0n) throw new Error("INVALID_FX_RATE");
  return roundRatio(
    minor * numerator * 10n ** BigInt(to),
    10n ** BigInt(fraction.length + from),
  );
}

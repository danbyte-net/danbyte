const MIB = 1024 * 1024

/** Memory in GB, the way the hardware spec sheet prints it (#244). A BMC
 * reports DIMMs in MiB, so 32 GiB is stored as 34 359 738 368 bytes; the part
 * form writes decimal GB, 32 000 000 000. A whole number of MiB reads in GiB,
 * anything else in decimal GB, so both show as "32 GB". A list is summed, and
 * a total stays in GB ("1024 GB", not "1.1 TB"): whole when exact, else to
 * one decimal. */
export function formatMemory(
  bytes: number | null | undefined | readonly (number | null | undefined)[]
): string {
  const list = Array.isArray(bytes) ? bytes : [bytes]
  let mib = 0 // the binary sizes, in MiB
  let dec = 0 // the decimal sizes, in bytes
  for (const b of list) {
    if (!b || b <= 0) continue
    if (b % MIB === 0) mib += b / MIB
    else dec += b
  }
  if (!mib && !dec) return ""
  // GB = mib / 1024 + dec / 1e9, over their common denominator 2e9 so a
  // whole figure is recognised exactly.
  const num = mib * 1_953_125 + dec * 2
  const text = num % 2e9 === 0 ? String(num / 2e9) : (num / 2e9).toFixed(1)
  return `${text} GB`
}

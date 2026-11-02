// A body size in millimetres as a form edits it (device types, devices).

/** A size as the form holds it: blank stays blank, not 0. */
export const mmText = (v: number | string | null | undefined) =>
  v == null || v === "" ? "" : String(Number(v))

/** Blank clears the size. */
export const mmOrNull = (v: string) => (v.trim() === "" ? null : Number(v))

/** Tenths of a millimetre, as the API keeps sizes. */
export const MM_INPUT = {
  type: "number",
  inputMode: "decimal",
  step: 0.1,
  max: 5000,
} as const

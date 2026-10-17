/** `items` in runs of at most `size`, in order - for an endpoint that bounds
 * how many ids one call takes. */
export function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size))
  return out
}

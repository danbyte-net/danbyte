import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { Loading } from "./loading"

const html = (el: React.ReactElement) => renderToStaticMarkup(el)

describe("Loading", () => {
  it("is the splash spinner with a muted label under it", () => {
    const out = html(<Loading />)
    expect(out).toContain('role="status"')
    expect(out).toContain('aria-live="polite"')
    // The first-load splash's spinner, exactly.
    expect(out).toContain("size-5 text-zinc-400 dark:text-zinc-500")
    expect(out).toContain("animate-spin")
    expect(out).toMatch(/text-xs text-muted-foreground">Loading…</)
    // Stacked and centred in whatever it fills.
    expect(out).toContain("flex-col items-center justify-center")
  })

  it("leaves the status to the wrapper, not a second one on the icon", () => {
    const out = html(<Loading />)
    expect(out.match(/role="status"/g)).toHaveLength(1)
    expect(out).toContain('aria-hidden="true"')
    expect(out).not.toContain('aria-label="Loading"')
  })

  it("keeps the text for screen readers only when the label is off", () => {
    const out = html(<Loading label={false} />)
    expect(out).toMatch(/class="sr-only">Loading…</)
    expect(out).not.toContain("text-xs text-muted-foreground")
  })

  it("takes the caller's box", () => {
    const out = html(<Loading className="min-h-svh" />)
    expect(out).toContain("min-h-svh")
    // tailwind-merge drops the default minimum the caller replaced.
    expect(out).not.toContain("min-h-24")
  })
})

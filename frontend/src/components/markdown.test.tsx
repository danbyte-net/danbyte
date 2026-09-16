import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { Markdown } from "./markdown"

const html = (source: string, issueBase?: string) =>
  renderToStaticMarkup(<Markdown source={source} issueBase={issueBase} />)

describe("Markdown", () => {
  it("keeps the basics", () => {
    const out = html(
      "# Title\n\nSome **bold** and `code` and [a link](https://x.y)."
    )
    expect(out).toContain("<h3")
    expect(out).toContain("<strong")
    expect(out).toContain("<code")
    expect(out).toContain('href="https://x.y"')
  })

  it("never passes HTML through", () => {
    const out = html("<script>alert(1)</script> and [x](javascript:alert(1))")
    expect(out).not.toContain("<script>")
    expect(out).toContain("&lt;script&gt;")
    expect(out).not.toContain("javascript:")
  })

  it("renders the GitHub extras", () => {
    const out = html(
      [
        "| Col | Num |",
        "| --- | ---: |",
        "| a | 1 |",
        "",
        "> quoted",
        "",
        "---",
        "",
        "- [x] done ~~gone~~",
        "- [ ] open",
        "  - nested",
        "",
        "See #126 and https://example.com/x.",
      ].join("\n"),
      "https://github.com/org/repo/issues/"
    )
    expect(out).toContain("<table")
    expect(out).toContain("text-align:right")
    expect(out).toContain("<blockquote")
    expect(out).toContain("<hr")
    expect(out).toContain('aria-label="done" checked')
    expect(out).toContain("<del>gone</del>")
    expect(out).toContain("nested")
    expect(out).toContain('href="https://github.com/org/repo/issues/126"')
    expect(out).toContain('href="https://example.com/x"')
    expect(out).toContain("x</a>.")
  })

  it("leaves an issue reference plain without a repo", () => {
    expect(html("fixes #1")).not.toContain("<a")
  })
})

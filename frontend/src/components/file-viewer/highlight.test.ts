import { describe, expect, it } from "vitest"
import { EditorState } from "@codemirror/state"
import { ensureSyntaxTree } from "@codemirror/language"

import {
  highlightFromName,
  isIpv6,
  pickHighlight,
  sniffHighlight,
  syntaxFor,
  tokenize,
} from "./highlight"
import type { Highlight } from "./highlight"

/** The style of the first token whose text is `text` on any line. */
function styleOf(
  lang: Exclude<Highlight, "text">,
  src: string,
  text: string
): string | undefined {
  for (const line of tokenize(lang, src))
    for (const [tok, style] of line) if (tok === text) return style
  return undefined
}

describe("json", () => {
  const src = `{
  "name": "edge-01",
  "mtu": 9000,
  "ratio": -1.5e3,
  "up": true,
  "down": false,
  "note": null,
  "tags": ["a", "b \\" c"]
}`
  it("tells keys from string values", () => {
    expect(styleOf("json", src, '"name"')).toBe("propertyName")
    expect(styleOf("json", src, '"edge-01"')).toBe("string")
    expect(styleOf("json", src, '"a"')).toBe("string")
    expect(styleOf("json", src, '"b \\" c"')).toBe("string")
  })
  it("colours numbers and literals", () => {
    expect(styleOf("json", src, "9000")).toBe("number")
    expect(styleOf("json", src, "-1.5e3")).toBe("number")
    expect(styleOf("json", src, "true")).toBe("bool")
    expect(styleOf("json", src, "false")).toBe("bool")
    expect(styleOf("json", src, "null")).toBe("null")
  })
  it("marks punctuation", () => {
    expect(styleOf("json", src, "{")).toBe("bracket")
    expect(styleOf("json", src, ":")).toBe("punctuation")
    expect(styleOf("json", src, ",")).toBe("punctuation")
  })
})

describe("xml", () => {
  const src = `<?xml version="1.0"?>
<!-- a comment
     over two lines -->
<config xmlns:x="urn:x">
  <host name='r1' enabled="true">r1 &amp; r2</host>
  <data><![CDATA[ <raw> ]]></data>
  <multi a="one
two"/>
</config>`
  it("colours tags, attributes and values", () => {
    expect(styleOf("xml", src, "config")).toBe("tagName")
    expect(styleOf("xml", src, "host")).toBe("tagName")
    expect(styleOf("xml", src, "name")).toBe("attributeName")
    expect(styleOf("xml", src, "xmlns:x")).toBe("attributeName")
    expect(styleOf("xml", src, "'r1'")).toBe("attributeValue")
    expect(styleOf("xml", src, '"true"')).toBe("attributeValue")
    expect(styleOf("xml", src, "<")).toBe("angleBracket")
    expect(styleOf("xml", src, "&amp;")).toBe("character")
  })
  it("carries comments and values across lines", () => {
    const lines = tokenize("xml", src)
    expect(lines[1]).toEqual([["<!-- a comment", "comment"]])
    expect(lines[2]).toEqual([["     over two lines -->", "comment"]])
    expect(lines[7][0]).toEqual(['two"', "attributeValue"])
  })
  it("colours CDATA and the declaration", () => {
    expect(styleOf("xml", src, "<![CDATA[ <raw> ]]>")).toBe("string.special")
    expect(styleOf("xml", src, "xml")).toBe("tagName")
    expect(styleOf("xml", src, "version")).toBe("attributeName")
  })
  it("leaves text between tags plain", () => {
    expect(styleOf("xml", src, "r1 ")).toBeUndefined()
  })
})

describe("yaml", () => {
  const src = `---
# pipeline
name: Deploy FRR
steps:
  - kind: script
    timeout: 30
    retry: false
    note: ~
    title: "quoted: value" # trailing
    tags: [a, b]
    body: |
      echo "not: a key"
      exit 0
after: done`
  it("colours keys, values and comments", () => {
    expect(styleOf("yaml", src, "name")).toBe("propertyName")
    expect(styleOf("yaml", src, "kind")).toBe("propertyName")
    expect(styleOf("yaml", src, "Deploy")).toBe("string")
    expect(styleOf("yaml", src, "30")).toBe("number")
    expect(styleOf("yaml", src, "false")).toBe("bool")
    expect(styleOf("yaml", src, "~")).toBe("null")
    expect(styleOf("yaml", src, '"quoted: value"')).toBe("string")
    expect(styleOf("yaml", src, "# trailing")).toBe("comment")
    expect(styleOf("yaml", src, "# pipeline")).toBe("comment")
    expect(styleOf("yaml", src, "---")).toBe("meta")
  })
  it("marks list dashes and flow brackets", () => {
    expect(styleOf("yaml", src, "-")).toBe("punctuation")
    expect(styleOf("yaml", src, "[")).toBe("bracket")
  })
  it("reads a block scalar as one string until it dedents", () => {
    const lines = tokenize("yaml", src)
    expect(lines[11]).toEqual([['      echo "not: a key"', "string"]])
    expect(lines[13][0]).toEqual(["after", "propertyName"])
  })
})

describe("ini / systemd", () => {
  const src = `# generated
[Match]
Name=eth0

[Network]
Address=10.0.0.5/24
Address=2001:db8::5/64
DHCP=no
MTUBytes=9000
; old
Description = uplink port`
  it("colours sections, keys and values", () => {
    expect(styleOf("ini", src, "[Match]")).toBe("heading")
    expect(styleOf("ini", src, "Name")).toBe("propertyName")
    expect(styleOf("ini", src, "Description")).toBe("propertyName")
    expect(styleOf("ini", src, "=")).toBe("operator")
    expect(styleOf("ini", src, "10.0.0.5/24")).toBe("address")
    expect(styleOf("ini", src, "2001:db8::5/64")).toBe("address")
    expect(styleOf("ini", src, "no")).toBe("bool")
    expect(styleOf("ini", src, "9000")).toBe("number")
    expect(styleOf("ini", src, "# generated")).toBe("comment")
    expect(styleOf("ini", src, "; old")).toBe("comment")
    expect(styleOf("ini", src, "eth0")).toBeUndefined()
  })
})

describe("network config", () => {
  const src = `! FRR
hostname r1
interface eth0
 description to "core 1"
 ip address 192.0.2.1/31
 ipv6 address fe80::1/64
 mtu 9000
!
router bgp 65001
 neighbor 192.0.2.0 remote-as 65002
 address-family ipv4 unicast
 exit-address-family
# ifupdown
auto lo
iface lo inet loopback`
  it("colours section keywords at the start of a line only", () => {
    expect(styleOf("netconf", src, "interface")).toBe("keyword")
    expect(styleOf("netconf", src, "router")).toBe("keyword")
    expect(styleOf("netconf", src, "address-family")).toBe("keyword")
    expect(styleOf("netconf", src, "exit-address-family")).toBe("keyword")
    expect(styleOf("netconf", src, "auto")).toBe("keyword")
    expect(styleOf("netconf", src, "iface")).toBe("keyword")
    // `address` after `ip` is not a section.
    expect(styleOf("netconf", src, "address")).toBeUndefined()
  })
  it("colours addresses, numbers, strings and comments", () => {
    expect(styleOf("netconf", src, "192.0.2.1/31")).toBe("address")
    expect(styleOf("netconf", src, "192.0.2.0")).toBe("address")
    expect(styleOf("netconf", src, "fe80::1/64")).toBe("address")
    expect(styleOf("netconf", src, "65001")).toBe("number")
    expect(styleOf("netconf", src, '"core 1"')).toBe("string")
    expect(styleOf("netconf", src, "! FRR")).toBe("comment")
    expect(styleOf("netconf", src, "!")).toBe("comment")
    expect(styleOf("netconf", src, "# ifupdown")).toBe("comment")
    expect(styleOf("netconf", src, "eth0")).toBeUndefined()
  })
  it("knows an IPv6 address from other colon words", () => {
    expect(isIpv6("2001:db8::1")).toBe(true)
    expect(isIpv6("::")).toBe(true)
    expect(isIpv6("::ffff:192.0.2.1")).toBe(true)
    expect(isIpv6("2001:db8::/32")).toBe(true)
    expect(isIpv6("vlan:10:20")).toBe(false)
    expect(isIpv6("ab:cd")).toBe(false)
    expect(isIpv6(":a:b")).toBe(false)
    expect(isIpv6("2001:db8::1/abc")).toBe(false)
  })
})

describe("log", () => {
  const src = `2026-11-07T10:00:01Z starting run
[2026-11-07 10:00:02,123] WARNING: deprecated option
12:00:03 TASK [push] ok: [r1]
fatal: [r2]: FAILED! => unreachable
PLAY RECAP r1 : ok=3 changed=1 failed=0
Error: exit code 1
script exited with code 0
deploy succeeded`
  it("dims timestamps", () => {
    expect(styleOf("log", src, "2026-11-07T10:00:01Z")).toBe("timestamp")
    expect(styleOf("log", src, "[2026-11-07 10:00:02,123]")).toBe("timestamp")
    expect(styleOf("log", src, "12:00:03")).toBe("timestamp")
  })
  it("colours failures, warnings and successes", () => {
    expect(styleOf("log", src, "FAILED")).toBe("logError")
    expect(styleOf("log", src, "fatal")).toBe("logError")
    expect(styleOf("log", src, "Error")).toBe("logError")
    expect(styleOf("log", src, "exit code 1")).toBe("logError")
    expect(styleOf("log", src, "exited with code 0")).toBe("logOk")
    expect(styleOf("log", src, "WARNING")).toBe("logWarn")
    expect(styleOf("log", src, "ok")).toBe("logOk")
    expect(styleOf("log", src, "succeeded")).toBe("logOk")
  })
  it("leaves zero counters alone", () => {
    const recap = tokenize("log", src)[4]
    expect(recap.find(([tok]) => tok === "failed")).toBeUndefined()
    expect(recap.find(([tok]) => tok === "ok")?.[1]).toBe("logOk")
  })
})

describe("picking a language", () => {
  it("reads the file name", () => {
    expect(highlightFromName("/etc/frr/frr.conf")).toBe("netconf")
    expect(highlightFromName("/etc/network/interfaces")).toBe("netconf")
    expect(highlightFromName("10-uplink.network")).toBe("ini")
    expect(highlightFromName("netplan.yaml")).toBe("yaml")
    expect(highlightFromName("a.yml.j2")).toBe("yaml")
    expect(highlightFromName("ctx.JSON")).toBe("json")
    expect(highlightFromName("page.xml")).toBe("xml")
    expect(highlightFromName("run.log")).toBe("log")
    expect(highlightFromName("notes.txt")).toBeNull()
    expect(highlightFromName("router.conf")).toBeNull()
    expect(highlightFromName(undefined)).toBeNull()
  })
  it("sniffs the text", () => {
    expect(sniffHighlight('{"a": 1}')).toBe("json")
    expect(sniffHighlight("\n  [1, 2]")).toBe("json")
    expect(sniffHighlight("[Match]\nName=eth0")).toBe("ini")
    expect(sniffHighlight('<?xml version="1.0"?>')).toBe("xml")
    expect(sniffHighlight("<config/>")).toBe("xml")
    expect(sniffHighlight("# c\nname: x")).toBe("yaml")
    expect(sniffHighlight("hostname r1")).toBeNull()
  })
  it("prefers the prop, then the name, then the text", () => {
    expect(pickHighlight({ language: "log", name: "a.json", text: "{" })).toBe(
      "log"
    )
    expect(pickHighlight({ language: "text", text: "{}" })).toBe("text")
    expect(pickHighlight({ language: "auto", name: "a.xml", text: "{}" })).toBe(
      "xml"
    )
    expect(pickHighlight({ language: "auto", text: "{}" })).toBe("json")
    expect(pickHighlight({ text: "hostname r1" })).toBe("text")
    expect(pickHighlight({ text: "hostname r1", fallback: "netconf" })).toBe(
      "netconf"
    )
  })
})

describe("editor wiring", () => {
  it("returns one shared extension per language, none for text", () => {
    expect(syntaxFor("json")).toBe(syntaxFor("json"))
    expect(syntaxFor("text")).toEqual([])
  })
  it("parses a document into styled nodes", () => {
    const state = EditorState.create({
      doc: '{"a": 1}',
      extensions: [syntaxFor("json")],
    })
    const tree = ensureSyntaxTree(state, state.doc.length, 5000)
    const names: string[] = []
    tree?.iterate({ enter: (n) => void names.push(n.name) })
    expect(names).toContain("propertyName")
    expect(names).toContain("number")
  })
})

describe("large input", () => {
  it("tokenizes 20k lines of every language quickly", () => {
    const samples: Record<Exclude<Highlight, "text">, string> = {
      json: '  "key-name": ["value", 12.5, true, null],',
      xml: "  <item name=\"a\" b='c'>text &amp; more</item> <!-- c -->",
      yaml: "  - key: value 10 # comment",
      ini: "Address=2001:db8::1/64 10.0.0.1/24 yes",
      netconf: " neighbor 192.0.2.1 remote-as 65001 fe80::1",
      log: "2026-11-07T10:00:00Z step ok: [r1] WARNING failed=0 exit code 1",
    }
    // Pathological lines too: long runs that defeat a backtracking regex.
    const nasty = [
      "a".repeat(5000) + ":",
      " ".repeat(5000) + "x",
      ":".repeat(3000),
      '"' + "\\".repeat(4001),
      "1.".repeat(2000),
      "<" + "a ".repeat(2000),
    ]
    for (const [lang, line] of Object.entries(samples)) {
      const text = [...Array(20000).fill(line), ...nasty].join("\n")
      const start = performance.now()
      const lines = tokenize(lang as Exclude<Highlight, "text">, text)
      const ms = performance.now() - start
      expect(lines.length).toBe(20000 + nasty.length)
      // Generous for slow CI; a backtracking regex takes seconds here.
      expect(ms, `${lang} took ${ms.toFixed(0)}ms`).toBeLessThan(2000)
    }
  })
})

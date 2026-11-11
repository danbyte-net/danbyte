// @vitest-environment jsdom
import type { ReactNode } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type {
  DiscoveryFinding,
  HostPackage,
  PackageAdvisoryState,
} from "@/lib/api"
import { buildHostPackageColumns } from "@/components/columns/inventory-columns"
import { buildFindingColumns } from "@/components/columns/service-scan-columns"
import { splitPackageNames } from "@/components/application-form"
import { AdvisoryNote } from "./advisory-note"

// The package inventory feeding the model (#451): the Packages tab's
// Application and CVEs columns, the "not fetched" line, the inventory's
// proposals in the review queue and the application form's package names.

vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  Link: ({
    children,
    to,
    search,
    ...rest
  }: {
    children: ReactNode
    to: string
    search?: Record<string, string>
  }) => (
    <a
      data-to={to}
      data-search={search ? JSON.stringify(search) : undefined}
      {...rest}
    >
      {children}
    </a>
  ),
}))

afterEach(cleanup)

const pkg: HostPackage = {
  id: "pk1",
  name: "libssl3t64",
  version: "3.5.1-1",
  arch: "amd64",
  source_name: "openssl",
  source_version: "3.5.1-1",
  type: "deb",
  ecosystem: "Debian:13",
  purl: "",
  publisher: "",
  first_seen: "2026-11-10T00:00:00Z",
  last_seen: "2026-11-10T00:00:00Z",
  application: { id: "a1", name: "OpenSSL" },
  cves: { count: 3, severity: "critical" },
}

function cell(id: string, row: HostPackage) {
  const col = buildHostPackageColumns({
    host: { kind: "virtual_machine", id: "vm1" },
  }).find((c) => c.id === id)!
  const render_ = col.cell as (ctx: {
    row: { original: HostPackage }
  }) => ReactNode
  return render(<>{render_({ row: { original: row } })}</>)
}

describe("packages tab columns", () => {
  it("adds Application and CVEs after the version", () => {
    const ids = buildHostPackageColumns().map((c) => c.id)
    expect(ids.slice(0, 4)).toEqual(["name", "version", "application", "cves"])
  })

  it("links the application", () => {
    cell("application", pkg)
    expect(screen.getByText("OpenSSL").getAttribute("data-to")).toBe(
      "/applications/$id"
    )
  })

  it("shows the CVE count on the worst severity's badge, linked to the tab", () => {
    cell("cves", pkg)
    const a = screen.getByText("3")
    expect(a.getAttribute("aria-label")).toBe("3 open, worst Critical")
    expect(JSON.parse(a.getAttribute("data-search")!)).toEqual({
      tab: "vulnerabilities",
      vpackage: "pk1",
    })
    cleanup()
    cell("cves", { ...pkg, cves: { count: 0, severity: "" } })
    expect(screen.queryByText("0")).toBeNull()
  })
})

describe("advisory note", () => {
  const base: PackageAdvisoryState = {
    mode: "browser",
    state: "not_fetched",
    last_fetch: null,
    can_sync: true,
  }

  it("says nothing once fetched", () => {
    const { container } = render(
      <AdvisoryNote value={{ ...base, state: "fetched" }} />
    )
    expect(container.textContent).toBe("")
  })

  it("browser mode: not fetched, Sync now", () => {
    render(<AdvisoryNote value={base} />)
    screen.getByText(
      "Vulnerability data for these packages has not been fetched"
    )
    expect(screen.getByText("Sync now").getAttribute("data-to")).toBe(
      "/settings/vulnerabilities/sync"
    )
    screen.getByText("Never fetched")
  })

  it("a distribution without an advisory source says so", () => {
    render(
      <AdvisoryNote
        value={{ ...base, state: "no_source", distribution: "Fedora" }}
      />
    )
    screen.getByText("No advisory source for Fedora")
    expect(screen.queryByText("Sync now")).toBeNull()
  })

  it("upload and server modes", () => {
    render(<AdvisoryNote value={{ ...base, mode: "upload" }} />)
    const link = screen.getByText("Import OSV file")
    // The Vulnerability data card, not the top of the page.
    expect(link.getAttribute("data-to")).toBe("/settings/admin")
    expect(link.getAttribute("hash")).toBe("vulnerability-data")
    cleanup()
    render(
      <AdvisoryNote value={{ ...base, mode: "server", state: "queued" }} />
    )
    screen.getByText("Advisory fetch queued")
    cleanup()
    render(<AdvisoryNote value={{ ...base, can_sync: false }} />)
    expect(screen.queryByText("Sync now")).toBeNull()
  })
})

describe("inventory findings", () => {
  const platform: DiscoveryFinding = {
    id: "platform:virtual_machine:v1",
    kind: "platform",
    host: { kind: "virtual_machine", id: "v1", name: "vm13" },
    title: "Set platform to Debian 13",
    proposal: {
      platform: null,
      platform_name: "Debian 13",
      current: { id: "p0", name: "Linux 6.x/2.6 Kernel" },
      eol: { product: "debian", cycle: "13" },
    },
    os: {
      os_id: "debian",
      version_id: "13",
      pretty_name: "Debian GNU/Linux 13 (trixie)",
      collected_at: "2026-11-10T00:00:00Z",
    },
    confidence: "high",
    ignored: false,
    evidence: [],
  }
  const app: DiscoveryFinding = {
    id: "application:nginx",
    kind: "application",
    host: null,
    title: "Application nginx found on 12 hosts",
    proposal: {
      application: null,
      application_name: "nginx",
      software: "nginx",
      package_names: ["deb:nginx", "rpm:nginx"],
      hosts: 12,
    },
    packages: [
      {
        kind: "device",
        id: "d1",
        name: "web-01",
        package: "nginx",
        version: "1.26.3-3",
      },
    ],
    confidence: "high",
    ignored: false,
    evidence: [],
  }

  function renderCell(id: string, f: DiscoveryFinding) {
    const col = buildFindingColumns().find((c) => c.id === id)!
    const r = col.cell as (ctx: {
      row: { original: DiscoveryFinding }
    }) => ReactNode
    return render(<>{r({ row: { original: f } })}</>)
  }

  it("names the platform, the new one and its cycle", () => {
    renderCell("kind", platform)
    screen.getByText("Debian 13 (debian 13)")
    screen.getByText("Set platform · new platform")
    cleanup()
    renderCell("evidence", platform)
    screen.getByText("Debian GNU/Linux 13 (trixie)")
    cleanup()
    renderCell("source", platform)
    screen.getByText("Package inventory")
  })

  it("keeps the queue's column order", () => {
    const ids = buildFindingColumns().map((c) => c.id)
    expect(ids).toEqual([
      "select",
      "host",
      "port",
      "kind",
      "confidence",
      "source",
      "evidence",
      "last_seen",
    ])
  })

  it("one application finding counts its hosts", () => {
    renderCell("kind", app)
    screen.getByText("Add application · new application")
    cleanup()
    renderCell("host", app)
    screen.getByText("12 hosts")
    cleanup()
    renderCell("evidence", app)
    screen.getByText("nginx")
  })
})

describe("application form", () => {
  it("splits package names by line or comma", () => {
    expect(splitPackageNames("deb:nginx\n rpm:nginx , \n\napk:nginx")).toEqual([
      "deb:nginx",
      "rpm:nginx",
      "apk:nginx",
    ])
  })
})

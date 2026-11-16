// @vitest-environment jsdom
import type { ReactNode } from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Device, VirtualMachine } from "@/lib/api"
import { deviceConnectHost, vmConnectHost } from "@/lib/connect-host"
import { HostConnectMenu } from "./host-connect-menu"
import { HostTerminalDialog } from "./host-terminal-dialog"

// One Connect menu for devices and VMs: the same protocols and terminal
// entry, filled from the host, gated on that host type's `connect` verb.

const { meState, apiAllMock } = vi.hoisted(() => {
  const grants: Record<string, string[]> = {}
  return { meState: { grants, terminal: true }, apiAllMock: vi.fn() }
})

vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    me: { username: "alice", ssh_terminal_enabled: meState.terminal },
    canDo: (type: string, action: string) =>
      (meState.grants[type] ?? []).includes(action),
  }),
}))
vi.mock("@/lib/api-all", () => ({ apiAll: apiAllMock }))
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  Link: ({
    children,
    to,
    params,
    search,
    ...rest
  }: {
    children?: ReactNode
    to: string
    params?: { id: string }
    search?: Record<string, string>
  }) => (
    <a
      href={`${to.replace("$id", params?.id ?? "")}?${new URLSearchParams(search).toString()}`}
      {...rest}
    >
      {children}
    </a>
  ),
}))
// xterm needs a real canvas; the terminal surface itself is not under test.
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80
    rows = 24
    loadAddon() {}
    open() {}
    write() {}
    focus() {}
    dispose() {}
    onData() {}
    onResize() {}
  },
}))
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}))
vi.mock("@xterm/xterm/css/xterm.css", () => ({}))

const VM = {
  id: "vm1",
  name: "web1",
  primary_ip: { id: "ip1", ip_address: "10.8.8.8/24", dns_name: "" },
} as unknown as VirtualMachine

const DEVICE = {
  id: "dev1",
  name: "sw1",
  primary_ip: null,
  oob_ip: { id: "ip2", ip_address: "10.0.0.9", dns_name: "" },
} as unknown as Device

const PROTOCOLS = [
  {
    id: "p1",
    name: "SSH",
    url_template: "ssh://{username}@{host}:{port}",
    default_port: 22,
    icon: "",
    enabled: true,
  },
]

function results(url: string) {
  if (url.startsWith("/api/monitoring/connect-protocols/"))
    return { results: PROTOCOLS }
  if (url.startsWith("/api/monitoring/device-credentials/"))
    return {
      results: url.includes("virtual_machine=vm1")
        ? [{ id: "c1", name: "admin", username: "vmadmin", kind: "ssh_key" }]
        : [],
    }
  return { results: [] }
}

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

function openMenu() {
  const trigger = screen.getByRole("button", { name: /connect/i })
  fireEvent.keyDown(trigger, { key: "Enter" })
}

beforeEach(() => {
  meState.grants = { virtualmachine: ["view", "connect"] }
  meState.terminal = true
  apiAllMock.mockReset()
  apiAllMock.mockImplementation(async (url: string) => results(url))
  try {
    localStorage.clear()
  } catch {
    // storage unavailable
  }
})
afterEach(() => cleanup())

describe("HostConnectMenu on a VM", () => {
  it("queries the VM's protocols and credentials and offers the terminal", async () => {
    wrap(<HostConnectMenu host={vmConnectHost(VM)} />)
    openMenu()
    expect(await screen.findByText("vmadmin")).toBeTruthy()
    expect(screen.getByText("Open web terminal")).toBeTruthy()
    await screen.findByText("SSH")
    const urls = apiAllMock.mock.calls.map((c) => c[0] as string)
    expect(urls).toContain(
      "/api/monitoring/connect-protocols/?enabled=1&virtual_machine=vm1"
    )
    expect(urls).toContain(
      "/api/monitoring/device-credentials/?virtual_machine=vm1"
    )
  })

  it("fills {host} from the primary IP and {username} from the credential", async () => {
    localStorage.setItem("danbyte.connect.username.vm1", "vmadmin")
    wrap(<HostConnectMenu host={vmConnectHost(VM)} />)
    openMenu()
    const sub = await screen.findByText("SSH")
    fireEvent.keyDown(sub, { key: "ArrowRight" })
    expect(await screen.findByText("ssh://vmadmin@10.8.8.8:22")).toBeTruthy()
  })

  it("renders nothing without the VM connect verb", () => {
    meState.grants = {
      virtualmachine: ["view", "change"],
      device: ["view", "connect"],
    }
    const { container } = wrap(<HostConnectMenu host={vmConnectHost(VM)} />)
    expect(container.innerHTML).toBe("")
  })

  it("hides the terminal entry while the setting is off", async () => {
    meState.terminal = false
    wrap(<HostConnectMenu host={vmConnectHost(VM)} />)
    openMenu()
    await screen.findByText("SSH")
    expect(screen.queryByText("Open web terminal")).toBeNull()
  })
})

describe("HostConnectMenu on a device", () => {
  it("still filters on ?device= and uses the OOB IP when there is no primary", async () => {
    meState.grants = { device: ["view", "connect"] }
    localStorage.setItem("danbyte.connect.username.dev1", "")
    wrap(<HostConnectMenu host={deviceConnectHost(DEVICE)} />)
    openMenu()
    const sub = await screen.findByText("SSH")
    const urls = apiAllMock.mock.calls.map((c) => c[0] as string)
    expect(urls).toContain(
      "/api/monitoring/connect-protocols/?enabled=1&device=dev1"
    )
    fireEvent.keyDown(sub, { key: "ArrowRight" })
    expect(await screen.findByText("ssh://10.0.0.9:22")).toBeTruthy()
  })
})

describe("HostTerminalDialog on a VM", () => {
  it("points at the VM's Credentials card when it has no SSH credential", async () => {
    apiAllMock.mockImplementation(async () => ({ results: [] }))
    wrap(
      <HostTerminalDialog
        host={vmConnectHost(VM)}
        open
        onOpenChange={() => {}}
      />
    )
    expect(screen.getByText("Terminal - web1")).toBeTruthy()
    const link = await screen.findByRole("link", { name: "Credentials card" })
    expect(link.getAttribute("href")).toBe(
      "/virtual-machines/vm1?tab=monitoring"
    )
    expect(
      screen.getByText(/This virtual machine has no stored SSH credential/)
    ).toBeTruthy()
  })

  it("opens the VM socket and links the host keys on an unknown key", async () => {
    const sockets: FakeSocket[] = []
    class FakeSocket {
      static OPEN = 1
      readyState = 1
      url: string
      sent: string[] = []
      onmessage: ((ev: { data: string }) => void) | null = null
      onclose: (() => void) | null = null
      constructor(url: string) {
        this.url = url
        sockets.push(this)
      }
      send(d: string) {
        this.sent.push(d)
      }
      close() {}
    }
    vi.stubGlobal("WebSocket", FakeSocket)
    vi.stubGlobal("requestAnimationFrame", () => 0)
    try {
      wrap(
        <HostTerminalDialog
          host={vmConnectHost(VM)}
          open
          onOpenChange={() => {}}
        />
      )
      fireEvent.click(screen.getByRole("button", { name: "My login" }))
      await waitFor(() =>
        expect(screen.getByLabelText<HTMLInputElement>("Username").value).toBe(
          "alice"
        )
      )
      fireEvent.click(screen.getByRole("button", { name: "Connect" }))
      expect(sockets).toHaveLength(1)
      expect(sockets[0].url).toContain("/ws/ssh/vm/vm1/?")
      expect(sockets[0].url).toContain("mode=interactive")
      sockets[0].onmessage?.({
        data: JSON.stringify({
          t: "error",
          m: "First connection to this virtual machine.",
          code: "hostkey_unknown",
        }),
      })
      const link = await screen.findByRole("link", { name: "SSH host keys" })
      expect(link.getAttribute("href")).toBe(
        "/virtual-machines/vm1?tab=certificates"
      )
      expect(
        screen.getByRole("button", { name: "Accept new host & retry" })
      ).toBeTruthy()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

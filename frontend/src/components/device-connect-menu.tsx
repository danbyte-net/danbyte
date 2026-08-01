import { useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  ChevronDown,
  Copy,
  ExternalLink,
  Plug,
  Terminal,
  TerminalSquare,
} from "lucide-react"

import { api } from "@/lib/api"
import type { ConnectProtocol, Device, Paginated } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { getLucideIcon } from "@/components/dynamic-icon"
import { DeviceTerminalDialog } from "@/components/device-terminal-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

// Only the username is ever exposed by the credentials endpoint — the secret
// stays server-side. We use it purely to offer choices for {username}.
interface DeviceCredentialRow {
  id: string
  username: string
}

/** Strip a CIDR mask ("10.0.0.1/24" → "10.0.0.1") before it lands in a URL. */
function stripMask(ip: string): string {
  return ip.split("/")[0]
}

/** The device's connect target: primary IP, then OOB IP, then its name. */
function hostFor(device: Device): string {
  const ip = device.primary_ip?.ip_address || device.oob_ip?.ip_address
  return ip ? stripMask(ip) : device.name
}

// String.replaceAll isn't guaranteed by every tsconfig lib target, so replace
// via split/join to stay portable.
function replaceAll(s: string, from: string, to: string): string {
  return s.split(from).join(to)
}

/**
 * Substitute a protocol's `url_template` for a device. When a value is absent
 * the placeholder is removed cleanly: no port collapses a trailing `:{port}`,
 * and no username collapses a dangling `{username}@` (and any resulting `//@`).
 */
function buildUrl(
  template: string,
  { host, name, port, username }: {
    host: string
    name: string
    port: number | null
    username: string
  }
): string {
  let url = template
  url = replaceAll(url, "{host}", host)
  url = replaceAll(url, "{name}", name)
  if (port != null) {
    url = replaceAll(url, "{port}", String(port))
  } else {
    url = replaceAll(url, ":{port}", "")
    url = replaceAll(url, "{port}", "")
  }
  if (username) {
    url = replaceAll(url, "{username}", username)
  } else {
    url = replaceAll(url, "{username}@", "")
    url = replaceAll(url, "{username}", "")
    url = replaceAll(url, "//@", "//")
  }
  return url
}

function isSshTemplate(template: string): boolean {
  return template.trim().toLowerCase().startsWith("ssh")
}

/** `ssh user@host` (or `ssh -p <port> user@host`), for pasting into a terminal. */
function sshCommand(host: string, port: number | null, username: string): string {
  const target = username ? `${username}@${host}` : host
  return port != null ? `ssh -p ${port} ${target}` : `ssh ${target}`
}

async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(label)
  } catch (e) {
    apiErrorToast(e, "Couldn't copy to the clipboard")
  }
}

/**
 * The device detail "Connect" dropdown. One item per enabled connect protocol,
 * each launching an OS scheme handler (ssh://, rdp://, …) with the template's
 * placeholders substituted client-side. Shown only to users who hold the device
 * `connect` verb; the protocol catalog itself is managed in Settings.
 */
export function DeviceConnectMenu({ device }: { device: Device }) {
  const { canDo, me } = useMe()
  const canConnect = canDo("device", "connect")
  const terminalEnabled = !!me.ssh_terminal_enabled
  const [open, setOpen] = useState(false)
  const [termOpen, setTermOpen] = useState(false)

  const protocolsQ = useQuery({
    queryKey: ["connect-protocols", "enabled"],
    queryFn: () =>
      api<Paginated<ConnectProtocol>>(
        "/api/monitoring/connect-protocols/?enabled=1"
      ),
    // The server already orders by weight,name.
    enabled: canConnect && open,
  })
  const credsQ = useQuery({
    queryKey: ["device-credentials", device.id],
    queryFn: () =>
      api<Paginated<DeviceCredentialRow>>(
        `/api/monitoring/device-credentials/?device=${device.id}`
      ),
    enabled: canConnect && open,
  })

  const usernames = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const c of credsQ.data?.results ?? []) {
      const u = c.username.trim()
      if (u && !seen.has(u)) {
        seen.add(u)
        out.push(u)
      }
    }
    return out
  }, [credsQ.data])

  const storeKey = `danbyte.connect.username.${device.id}`
  const [username, setUsername] = useState<string>(() => {
    try {
      return localStorage.getItem(storeKey) ?? ""
    } catch {
      return ""
    }
  })
  const chooseUsername = (u: string) => {
    setUsername(u)
    try {
      localStorage.setItem(storeKey, u)
    } catch {
      // Ignore — private-mode / disabled storage just loses the last-used hint.
    }
  }

  if (!canConnect) return null

  const host = hostFor(device)
  const protocols = protocolsQ.data?.results ?? []

  const launch = (proto: ConnectProtocol) => {
    const url = buildUrl(proto.url_template, {
      host,
      name: device.name,
      port: proto.default_port,
      username,
    })
    // OS-scheme handoff: an ssh:// / rdp:// URL can't be a TanStack `Link` (it
    // leaves the app entirely to the OS handler), so a transient anchor click
    // is the one legitimate raw-anchor case here — not internal navigation.
    // A web URL (a device management UI) opens in a new tab so Danbyte stays
    // put; a custom OS scheme is handed off in place without navigating away.
    const isWeb = /^https?:\/\//i.test(url)
    const a = document.createElement("a")
    a.href = url
    a.rel = "noopener noreferrer"
    if (isWeb) a.target = "_blank"
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  return (
    <>
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Plug className="h-3.5 w-3.5" /> Connect
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Username</DropdownMenuLabel>
        {usernames.length > 0 ? (
          <DropdownMenuRadioGroup
            value={username}
            onValueChange={chooseUsername}
          >
            {usernames.map((u) => (
              <DropdownMenuRadioItem
                key={u}
                value={u}
                // Keep the menu open so a protocol can be picked next.
                onSelect={(e) => e.preventDefault()}
              >
                <span className="font-mono text-xs">{u}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        ) : (
          // Radix menus hijack keystrokes for typeahead; stop propagation so
          // the field types normally.
          <div
            className="px-2 py-1.5"
            onKeyDown={(e) => e.stopPropagation()}
          >
            <Input
              value={username}
              onChange={(e) => chooseUsername(e.target.value)}
              placeholder="username (optional)"
              className="h-8 font-mono text-xs"
            />
          </div>
        )}
        <DropdownMenuSeparator />
        {terminalEnabled && (
          <>
            <DropdownMenuItem onSelect={() => setTermOpen(true)}>
              <TerminalSquare className="h-3.5 w-3.5" /> Open web terminal
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {protocolsQ.isLoading ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            Loading…
          </div>
        ) : protocols.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            No connect protocols —{" "}
            <Link
              to="/settings/connect"
              className="text-primary hover:underline"
            >
              configure them in Settings
            </Link>
          </div>
        ) : (
          protocols.map((proto) => {
            const Icon = getLucideIcon(proto.icon) ?? Plug
            const url = buildUrl(proto.url_template, {
              host,
              name: device.name,
              port: proto.default_port,
              username,
            })
            return (
              <DropdownMenuSub key={proto.id}>
                <DropdownMenuSubTrigger>
                  <Icon className="h-3.5 w-3.5" />
                  <span className="ml-2">{proto.name}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-56">
                  <div className="px-2 py-1 font-mono text-[11px] break-all text-muted-foreground">
                    {url}
                  </div>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => launch(proto)}>
                    <ExternalLink className="h-3.5 w-3.5" /> Launch
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      copy(url, `Copied ${proto.name} URL to the clipboard`)
                    }
                  >
                    <Copy className="h-3.5 w-3.5" /> Copy URL
                  </DropdownMenuItem>
                  {isSshTemplate(proto.url_template) && (
                    <DropdownMenuItem
                      onSelect={() =>
                        copy(
                          sshCommand(host, proto.default_port, username),
                          "Copied SSH command to the clipboard"
                        )
                      }
                    >
                      <Terminal className="h-3.5 w-3.5" /> Copy SSH command
                    </DropdownMenuItem>
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
    {terminalEnabled && (
      <DeviceTerminalDialog
        device={device}
        open={termOpen}
        onOpenChange={setTermOpen}
      />
    )}
    </>
  )
}

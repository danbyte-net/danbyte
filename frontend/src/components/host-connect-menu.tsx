import { useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  ChevronDown,
  Copy,
  ExternalLink,
  Plug,
  Terminal,
  TerminalSquare,
} from "lucide-react"

import { apiAll } from "@/lib/api-all"
import type { ConnectProtocol } from "@/lib/api"
import { copyWithToast } from "@/lib/clipboard"
import { hostFilterParam } from "@/lib/connect-host"
import type { ConnectHost } from "@/lib/connect-host"
import { useMe } from "@/lib/use-me"
import { getLucideIcon } from "@/components/dynamic-icon"
import { HostTerminalDialog } from "@/components/host-terminal-dialog"
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

// Only the username is ever exposed by the credentials endpoint - the secret
// stays server-side. We use it purely to offer choices for {username}.
interface CredentialRow {
  id: string
  username: string
}

// String.replaceAll isn't guaranteed by every tsconfig lib target, so replace
// via split/join to stay portable.
function replaceAll(s: string, from: string, to: string): string {
  return s.split(from).join(to)
}

/**
 * Substitute a protocol's `url_template` for a host. When a value is absent
 * the placeholder is removed cleanly: no port collapses a trailing `:{port}`,
 * and no username collapses a dangling `{username}@` (and any resulting `//@`).
 */
function buildUrl(
  template: string,
  {
    host,
    name,
    port,
    username,
  }: {
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
function sshCommand(
  host: string,
  port: number | null,
  username: string
): string {
  const target = username ? `${username}@${host}` : host
  return port != null ? `ssh -p ${port} ${target}` : `ssh ${target}`
}

/**
 * The "Connect" dropdown on a device or VM page. One item per enabled connect
 * protocol, each launching an OS scheme handler (ssh://, rdp://, …) with the
 * template's placeholders substituted client-side, plus the in-browser
 * terminal when it is on. Shown only to users who hold the host type's
 * `connect` verb; the protocol catalog itself is managed in Settings.
 */
export function HostConnectMenu({ host: target }: { host: ConnectHost }) {
  const { canDo, me } = useMe()
  const canConnect = canDo(target.kind, "connect")
  const param = hostFilterParam(target)
  const terminalEnabled = !!me.ssh_terminal_enabled
  const [open, setOpen] = useState(false)
  const [termOpen, setTermOpen] = useState(false)

  const protocolsQ = useQuery({
    queryKey: ["connect-protocols", "enabled", target.id],
    queryFn: () =>
      apiAll<ConnectProtocol>(
        // ?device= / ?virtual_machine= filters to protocols applicable to this
        // host (untargeted, or targeted at its type/role). The server already
        // orders by weight,name.
        `/api/monitoring/connect-protocols/?enabled=1&${param}=${target.id}`
      ),
    enabled: canConnect && open,
  })
  const credsQ = useQuery({
    queryKey: ["device-credentials", target.id],
    queryFn: () =>
      apiAll<CredentialRow>(
        `/api/monitoring/device-credentials/?${param}=${target.id}`
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

  const storeKey = `danbyte.connect.username.${target.id}`
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
      // Ignore - private-mode / disabled storage just loses the last-used hint.
    }
  }

  if (!canConnect) return null

  // The recorded address, else the name (resolved by the OS handler).
  const host = target.address || target.name
  const protocols = protocolsQ.data?.results ?? []

  const launch = (proto: ConnectProtocol) => {
    const url = buildUrl(proto.url_template, {
      host,
      name: target.name,
      port: proto.default_port,
      username,
    })
    // OS-scheme handoff: an ssh:// / rdp:// URL can't be a TanStack `Link` (it
    // leaves the app entirely to the OS handler), so a transient anchor click
    // is the one legitimate raw-anchor case here - not internal navigation.
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
            <div className="px-2 py-1.5" onKeyDown={(e) => e.stopPropagation()}>
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
              No connect protocols -{" "}
              <Link to="/settings/connect" className="link">
                configure them in Settings
              </Link>
            </div>
          ) : (
            protocols.map((proto) => {
              const Icon = getLucideIcon(proto.icon) ?? Plug
              const url = buildUrl(proto.url_template, {
                host,
                name: target.name,
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
                        void copyWithToast(
                          url,
                          `Copied ${proto.name} URL to the clipboard`
                        )
                      }
                    >
                      <Copy className="h-3.5 w-3.5" /> Copy URL
                    </DropdownMenuItem>
                    {isSshTemplate(proto.url_template) && (
                      <DropdownMenuItem
                        onSelect={() =>
                          void copyWithToast(
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
        <HostTerminalDialog
          host={target}
          open={termOpen}
          onOpenChange={setTermOpen}
        />
      )}
    </>
  )
}

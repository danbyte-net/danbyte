import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type Paginated, type WindowsConnection } from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  FormCheckbox,
  FormFooter,
  FormSelect,
  FormText,
  useFieldErrors,
} from "@/components/forms"

/** Create or edit a Windows server connection (WinRM). The password is
 * write-only: on edit, leaving it blank keeps the stored one. */
export function WindowsConnectionDialog({
  connection,
  onOpenChange,
}: {
  /** Present = edit; absent = create. */
  connection?: WindowsConnection
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const isEdit = !!connection
  const [name, setName] = useState(connection?.name ?? "")
  const [host, setHost] = useState(connection?.host ?? "")
  const [port, setPort] = useState(String(connection?.port ?? 5985))
  const [useTls, setUseTls] = useState(connection?.use_tls ?? false)
  const [verifySsl, setVerifySsl] = useState(connection?.verify_ssl ?? false)
  const [authMode, setAuthMode] = useState<string>(
    connection?.auth_mode ?? "ntlm"
  )
  const [username, setUsername] = useState(connection?.username ?? "")
  const [password, setPassword] = useState("")
  const [dhcp, setDhcp] = useState(connection?.dhcp_enabled ?? true)
  const [dns, setDns] = useState(connection?.dns_enabled ?? false)
  const [interval, setInterval] = useState(
    String(connection?.poll_interval_minutes ?? 5)
  )
  const [enabled, setEnabled] = useState(connection?.enabled ?? true)
  // Where DHCP scopes and imported DNS addresses land. Windows has no VRF
  // concept, so this is Danbyte's choice; empty = the Global VRF.
  const [vrfId, setVrfId] = useState(connection?.vrf_id ?? "")
  const [vrfMode, setVrfMode] = useState(connection?.vrf_mode ?? "pinned")
  const vrfs = useQuery({
    queryKey: ["vrfs-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>("/api/vrfs/?picker=1"),
    staleTime: 5 * 60_000,
  })

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        name: name.trim(),
        host: host.trim(),
        port: Number(port) || 5985,
        use_tls: useTls,
        verify_ssl: verifySsl,
        auth_mode: authMode,
        username: username.trim(),
        dhcp_enabled: dhcp,
        dns_enabled: dns,
        poll_interval_minutes: Number(interval) || 5,
        vrf_id: vrfId || null,
        vrf_mode: vrfMode,
        enabled,
      }
      if (password) body.password = password
      if (isEdit)
        return api<WindowsConnection>(
          `/api/windows-connections/${connection.id}/`,
          { method: "PATCH", body: JSON.stringify(body) }
        )
      return api<WindowsConnection>("/api/windows-connections/", {
        method: "POST",
        body: JSON.stringify(body),
      })
    },
    onSuccess: () => {
      reset()
      toast.success(isEdit ? "Server saved" : "Server added")
      qc.invalidateQueries({ queryKey: ["windows-connections"] })
      qc.invalidateQueries({ queryKey: ["windows-connection"] })
      onOpenChange(false)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const valid =
    name.trim() && host.trim() && username.trim() && (isEdit || password)

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit Windows server" : "Add Windows server"}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (valid) save.mutate()
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <FormText
              label="Name"
              value={name}
              onChange={setName}
              required
              placeholder="dc-01"
              error={fieldErrors.name}
            />
            <FormText
              label="Host"
              value={host}
              onChange={setHost}
              required
              placeholder="10.0.0.45"
              error={fieldErrors.host}
            />
            <FormText
              label="WinRM port"
              value={port}
              onChange={setPort}
              error={fieldErrors.port}
            />
            <FormSelect
              label="Authentication"
              value={authMode}
              onChange={(v) => setAuthMode(v ?? "ntlm")}
              options={[
                { value: "ntlm", label: "NTLM" },
                { value: "kerberos", label: "Kerberos" },
              ]}
            />
            <FormText
              label="Username"
              value={username}
              onChange={setUsername}
              required
              placeholder="svc-danbyte"
              error={fieldErrors.username}
            />
            <FormText
              label="Password"
              value={password}
              onChange={setPassword}
              type="password"
              placeholder={isEdit ? "(unchanged)" : ""}
              required={!isEdit}
              error={fieldErrors.password}
            />
            <FormText
              label="Poll interval (minutes)"
              value={interval}
              onChange={setInterval}
              error={fieldErrors.poll_interval_minutes}
            />
            <div className="flex flex-col justify-end gap-2 pb-1">
              <FormCheckbox
                label="Use TLS (port 5986)"
                checked={useTls}
                onChange={setUseTls}
              />
              {useTls && (
                <FormCheckbox
                  label="Verify TLS certificate"
                  checked={verifySsl}
                  onChange={setVerifySsl}
                />
              )}
            </div>
          </div>
          <div className="mt-1 grid gap-2 border-t border-border pt-3 sm:grid-cols-3">
            <FormCheckbox label="Sync DHCP" checked={dhcp} onChange={setDhcp} />
            <FormCheckbox label="Sync DNS" checked={dns} onChange={setDns} />
            {isEdit && (
              <FormCheckbox
                label="Enabled"
                checked={enabled}
                onChange={setEnabled}
              />
            )}
          </div>
          <div className="mt-1 grid gap-3 border-t border-border pt-3 sm:grid-cols-2">
            <FormSelect
              label="Address VRF"
              hint="Routing context for DHCP scope prefixes and addresses imported from DNS."
              value={vrfId || null}
              onChange={(v) => setVrfId(v ?? "")}
              noneLabel="Global"
              options={(vrfs.data?.results ?? []).map((v) => ({
                value: v.id,
                label: v.name,
              }))}
            />
            <FormSelect
              label="If nothing there contains it"
              hint="Searching other VRFs only ever places addresses that would otherwise be skipped - it never moves one that already fits."
              value={vrfMode}
              onChange={(v) => setVrfMode(v === "search" ? "search" : "pinned")}
              options={[
                { value: "pinned", label: "Skip the address" },
                { value: "search", label: "Look in other VRFs" },
              ]}
            />
          </div>
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={save.isPending}
            submitLabel={isEdit ? "Save changes" : "Add server"}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type WindowsConnection } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormCheckbox, FormSelect, FormText } from "@/components/forms"

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
      toast.success(isEdit ? "Server saved" : "Server added")
      qc.invalidateQueries({ queryKey: ["windows-connections"] })
      qc.invalidateQueries({ queryKey: ["windows-connection"] })
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e),
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
        <div className="grid gap-3 sm:grid-cols-2">
          <FormText
            label="Name"
            value={name}
            onChange={setName}
            required
            placeholder="dc-01"
          />
          <FormText
            label="Host"
            value={host}
            onChange={setHost}
            required
            placeholder="10.0.0.45"
          />
          <FormText label="WinRM port" value={port} onChange={setPort} />
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
          />
          <FormText
            label="Password"
            value={password}
            onChange={setPassword}
            type="password"
            placeholder={isEdit ? "(unchanged)" : ""}
            required={!isEdit}
          />
          <FormText
            label="Poll interval (minutes)"
            value={interval}
            onChange={setInterval}
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
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!valid || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : isEdit ? "Save" : "Add server"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

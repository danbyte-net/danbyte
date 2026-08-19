import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Field, FormCheckbox, FormSelect, FormText } from "@/components/forms"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  SettingsCard,
  SettingsGrid,
  SettingsHeader,
} from "@/components/settings/settings-card"
import { useDeploymentSettings } from "@/components/settings/use-deployment-settings"

export const Route = createFileRoute("/settings/security")({
  component: SecurityPage,
})

function SecurityPage() {
  const { canManageDeployment, isLoading } = useMe()
  if (isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (!canManageDeployment) {
    return (
      <p className="text-sm text-muted-foreground">
        You need the <span className="font-mono">users.manage</span> permission
        to manage deployment security settings.
      </p>
    )
  }
  return (
    <div className="space-y-6">
      <SettingsHeader title="Security">
        Where private keys live, and which internal hosts the server may reach.
      </SettingsHeader>
      <SettingsGrid>
        <SessionsCard />
        <SecretStoreCard />
        <OutboundCard />
        <SshTerminalCard />
      </SettingsGrid>
    </div>
  )
}

function SecretStoreCard() {
  const { data, save, savingKey } = useDeploymentSettings()
  const [provider, setProvider] = useState<"" | "local" | "vault">("")
  const [addr, setAddr] = useState("")
  const [mount, setMount] = useState("danbyte")
  const [verify, setVerify] = useState(true)
  const [token, setToken] = useState("")

  useEffect(() => {
    if (data) {
      setProvider(data.secrets_provider ?? "")
      setAddr(data.vault_addr ?? "")
      setMount(data.vault_mount ?? "danbyte")
      setVerify(data.vault_verify_tls ?? true)
      setToken("")
    }
  }, [data])

  if (!data) return null
  return (
    <SettingsCard
      title="Secret store"
      description="Where private keys for certificate requests (CSR) and ACME are kept - the certificate inventory itself never stores keys either way."
      onSave={() =>
        save.mutate({
          key: "secrets",
          patch: {
            secrets_provider: provider,
            vault_addr: addr.trim(),
            vault_mount: mount.trim() || "danbyte",
            vault_verify_tls: verify,
            ...(token ? { vault_token: token } : {}),
          },
        })
      }
      dirty={
        provider !== (data.secrets_provider ?? "") ||
        addr !== (data.vault_addr ?? "") ||
        mount !== (data.vault_mount ?? "danbyte") ||
        verify !== (data.vault_verify_tls ?? true) ||
        !!token
      }
      saving={savingKey === "secrets"}
      saveLabel="Save secret store"
    >
      <FormSelect
        label="Provider"
        value={provider || null}
        onChange={(v) => setProvider((v as "local" | "vault") ?? "")}
        noneLabel="Disabled"
        info={
          <>
            Where CSR / ACME private keys are stored. Deployment-wide on purpose
            - it decides where the organisation&apos;s keys live.
            <br />
            <b>Local</b> encrypts them at rest under{" "}
            <code>MONITORING_SECRET_KEY</code>. <b>Vault</b> keeps them in an
            external HashiCorp Vault / OpenBao and Danbyte holds only a
            reference. <b>Disabled</b> turns issuance off.
          </>
        }
        options={[
          { value: "local", label: "Local" },
          { value: "vault", label: "HashiCorp Vault / OpenBao" },
        ]}
      />
      {provider === "vault" && (
        <div className="space-y-3 rounded-md border border-border p-3">
          <FormText
            label="Vault address"
            value={addr}
            onChange={setAddr}
            placeholder="https://vault.danbyte.lan:8200"
          />
          <FormText
            label="KV v2 mount"
            value={mount}
            onChange={setMount}
            placeholder="danbyte"
          />
          <FormText
            label="Vault token"
            value={token}
            onChange={setToken}
            type="password"
            hint={
              data.vault_token_set ? "set - blank keeps current" : undefined
            }
            placeholder={data.vault_token_set ? "••••••" : "hvs.…"}
          />
          <FormCheckbox
            label="Verify TLS certificate"
            checked={verify}
            onChange={setVerify}
            hint="Turn off only for a Vault with a self-signed cert on a trusted network."
          />
        </div>
      )}
    </SettingsCard>
  )
}

function OutboundCard() {
  const { data, save, savingKey } = useDeploymentSettings()
  const [list, setList] = useState("")

  useEffect(() => {
    if (data) setList((data.ssrf_allowlist ?? []).join("\n"))
  }, [data])

  if (!data) return null
  return (
    <SettingsCard
      title="Outbound connections"
      description="Internal hosts the server may reach despite the SSRF guard - e.g. an internal NetBox for the importer, or an internal SMTP relay."
      onSave={() =>
        save.mutate({
          key: "ssrf",
          patch: {
            ssrf_allowlist: list
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
          },
        })
      }
      dirty={list !== (data.ssrf_allowlist ?? []).join("\n")}
      saving={savingKey === "ssrf"}
      saveLabel="Save allowlist"
    >
      <Field
        label="Allowed addresses / CIDRs"
        hint="One per line, e.g. 10.0.0.100 or 10.0.0.0/24. Merged with DANBYTE_SSRF_ALLOWLIST."
      >
        <textarea
          value={list}
          onChange={(e) => setList(e.target.value)}
          rows={4}
          spellCheck={false}
          placeholder={"10.0.0.100\n192.168.10.0/24"}
          className="w-full rounded-md border border-input bg-transparent p-2 font-mono text-[12px] leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </Field>
      <p className="text-[11px] text-muted-foreground">
        The guard stops tenant-supplied URLs (NetBox imports, webhooks, SMTP
        relays) from reaching loopback, cloud-metadata, and private ranges.
        Entries here punch specific holes - keep it as narrow as possible.
      </p>
    </SettingsCard>
  )
}

function SessionsCard() {
  const { data, save, savingKey } = useDeploymentSettings()
  const [timeout, setTimeoutMins] = useState("0")

  useEffect(() => {
    if (data)
      setTimeoutMins(String(data.session_idle_timeout_minutes ?? 0))
  }, [data])

  const endAll = useMutation({
    mutationFn: () =>
      api<{ ended: number }>("/api/deployment/end-all-sessions/", {
        method: "POST",
      }),
    onSuccess: (r) => {
      toast.success(
        `Signed out ${r.ended} session${r.ended === 1 ? "" : "s"} - you'll be asked to sign in again.`
      )
      // The caller's own session is gone now; bounce to a clean login.
      setTimeout(() => {
        window.location.href = "/login"
      }, 1200)
    },
    onError: (e) => apiErrorToast(e),
  })

  if (!data) return null
  const parsed = Math.max(0, Math.floor(Number(timeout) || 0))
  const dirty = parsed !== (data.session_idle_timeout_minutes ?? 0)
  return (
    <SettingsCard
      title="Sessions"
      description="Idle sign-out and an emergency switch to end every active session."
      onSave={() =>
        save.mutate({
          key: "sessions",
          patch: { session_idle_timeout_minutes: parsed },
        })
      }
      dirty={dirty}
      saving={savingKey === "sessions"}
      saveLabel="Save session settings"
      footer={
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="sm" variant="destructive" disabled={endAll.isPending}>
              {endAll.isPending ? "Ending…" : "End all sessions"}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>End all sessions?</AlertDialogTitle>
              <AlertDialogDescription>
                Every signed-in user - including you - will be logged out and must
                sign in again. API tokens keep working. Use this after a suspected
                compromise or a permissions change.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => endAll.mutate()}>
                End all sessions
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      }
    >
      <FormText
        label="Idle timeout (minutes)"
        type="number"
        value={timeout}
        onChange={setTimeoutMins}
        hint="Sign a user out after this many minutes without activity. Each request resets the timer. 0 = no idle timeout."
      />
    </SettingsCard>
  )
}

function SshTerminalCard() {
  const { data, save, savingKey } = useDeploymentSettings()
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    if (data) setEnabled(data.ssh_terminal_enabled ?? false)
  }, [data])

  if (!data) return null
  return (
    <SettingsCard
      title="In-browser SSH terminal"
      description="Let operators open a device shell from the browser, brokered by Danbyte."
      onSave={() =>
        save.mutate({
          key: "ssh_terminal",
          patch: { ssh_terminal_enabled: enabled },
        })
      }
      dirty={enabled !== (data.ssh_terminal_enabled ?? false)}
      saving={savingKey === "ssh_terminal"}
      saveLabel="Save terminal setting"
    >
      <FormCheckbox
        label="Enable the in-browser SSH terminal"
        checked={enabled}
        onChange={setEnabled}
        hint="Off by default. When on, a user with the device 'connect' permission can open an SSH session to a device through Danbyte. Each session verifies the device's SSH host key, uses a stored credential without exposing it, and is audited."
      />
      <p className="text-[11px] text-muted-foreground">
        A high-trust capability: it bridges the browser to a device shell. Grant
        the <span className="font-mono">connect</span> verb narrowly, and record
        each device&apos;s SSH host key so sessions can be verified.
      </p>
    </SettingsCard>
  )
}

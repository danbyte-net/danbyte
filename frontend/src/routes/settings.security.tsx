import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type SecretStoreField, type SecretStoreProvider } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Field, FormCheckbox, FormSelect, FormText } from "@/components/forms"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
import { ChatModelCard } from "@/components/settings/chat-model-card"
import {
  SettingsCard,
  SettingsGrid,
  SettingsRow,
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
        <DeliveryCard />
        <SshTerminalCard />
        <ChatModelCard />
      </SettingsGrid>
    </div>
  )
}

type FieldValue = string | boolean

function fieldDefault(f: SecretStoreField): FieldValue {
  if (f.type === "checkbox") return f.default === true
  if (f.type === "password") return ""
  return typeof f.default === "string" ? f.default : ""
}

function storedValue(
  data: Record<string, unknown>,
  f: SecretStoreField
): FieldValue {
  if (f.type === "password") return ""
  const v = data[f.name]
  if (f.type === "checkbox") return typeof v === "boolean" ? v : fieldDefault(f)
  return typeof v === "string" ? v : String(fieldDefault(f))
}

function SecretStoreCard() {
  const { data, save, savingKey } = useDeploymentSettings()
  const providers = useQuery({
    queryKey: ["secret-store-providers"],
    queryFn: () =>
      api<{ providers: SecretStoreProvider[] }>(
        "/api/deployment/secret-stores/"
      ),
    staleTime: 10 * 60_000,
  })
  const [provider, setProvider] = useState("")
  const [values, setValues] = useState<Record<string, FieldValue>>({})

  const list = providers.data?.providers ?? []
  const selected = list.find((p) => p.kind === provider)
  const stored = (data ?? {}) as unknown as Record<string, unknown>

  useEffect(() => {
    if (!data) return
    setProvider(data.secrets_provider ?? "")
    const next: Record<string, FieldValue> = {}
    for (const p of list)
      for (const f of p.fields) next[f.name] = storedValue(stored, f)
    setValues(next)
    // `stored` is derived from `data`; `list` changes only on first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, list.length])

  if (!data) return null

  const fields = selected?.fields ?? []
  const patch: Record<string, unknown> = { secrets_provider: provider }
  let dirty = provider !== (data.secrets_provider ?? "")
  for (const f of fields) {
    const v = values[f.name] ?? fieldDefault(f)
    if (f.type === "password") {
      if (v) {
        patch[f.name] = v
        dirty = true
      }
      continue
    }
    patch[f.name] = f.type === "text" && typeof v === "string" ? v.trim() : v
    if (v !== storedValue(stored, f)) dirty = true
  }

  const setValue = (name: string, v: FieldValue) =>
    setValues((prev) => ({ ...prev, [name]: v }))

  return (
    <SettingsCard
      title="Secret store"
      description="Where private keys for certificate requests (CSR) and ACME are kept - the certificate inventory itself never stores keys either way."
      onSave={() => save.mutate({ key: "secrets", patch })}
      dirty={dirty}
      saving={savingKey === "secrets"}
      saveLabel="Save secret store"
    >
      <FormSelect
        label="Provider"
        value={provider || null}
        onChange={(v) => setProvider(v ?? "")}
        noneLabel="Disabled"
        info={
          <>
            Where CSR / ACME private keys are stored. Deployment-wide on purpose
            - it decides where the organisation&apos;s keys live.{" "}
            <b>Disabled</b> turns issuance off.
            {list.map((p) => (
              <span key={p.kind}>
                <br />
                <b>{p.label}</b>: {p.description}
              </span>
            ))}
          </>
        }
        options={list.map((p) => ({ value: p.kind, label: p.label }))}
      />
      {selected && fields.length > 0 && (
        <div className="space-y-3 rounded-md border border-border p-3">
          {fields.map((f) => {
            const v = values[f.name] ?? fieldDefault(f)
            if (f.type === "checkbox") {
              return (
                <FormCheckbox
                  key={f.name}
                  label={f.label}
                  checked={v === true}
                  onChange={(c) => setValue(f.name, c)}
                  hint={f.hint}
                />
              )
            }
            const isSet = f.set_flag ? stored[f.set_flag] === true : false
            return (
              <FormText
                key={f.name}
                label={f.label}
                value={typeof v === "string" ? v : ""}
                onChange={(t) => setValue(f.name, t)}
                type={f.type === "password" ? "password" : undefined}
                hint={
                  f.type === "password" && isSet
                    ? "set - blank keeps current"
                    : f.hint
                }
                placeholder={
                  f.type === "password" && isSet ? "••••••" : f.placeholder
                }
              />
            )
          })}
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

/** Moved here from the Email page (#51): these apply to every transport -
 * Slack, Teams, Discord, PagerDuty, webhooks and mail alike - so filing them
 * under email was misleading, and it was the reason that page could not save
 * per card. */
function DeliveryCard() {
  const { data, save, savingKey } = useDeploymentSettings()
  const [baseUrl, setBaseUrl] = useState("")
  const [timeout, setWebhookTimeout] = useState("0")
  const [proxy, setProxy] = useState("")

  useEffect(() => {
    if (data) {
      setBaseUrl(data.public_base_url)
      setWebhookTimeout(String(data.webhook_timeout))
      setProxy(data.outbound_proxy)
    }
  }, [data])

  if (!data) return null
  return (
    <SettingsCard
      title="Outbound delivery"
      description="How notifications leave the server, whatever the transport."
      layout="rows"
      onSave={() =>
        save.mutate({
          key: "delivery",
          patch: {
            public_base_url: baseUrl.trim(),
            webhook_timeout: Number(timeout) || 0,
            outbound_proxy: proxy.trim(),
          },
        })
      }
      dirty={
        baseUrl !== data.public_base_url ||
        timeout !== String(data.webhook_timeout) ||
        proxy !== data.outbound_proxy
      }
      saving={savingKey === "delivery"}
      saveLabel="Save delivery"
    >
      <SettingsRow
        label="Public base URL"
        hint="Deep-links back to Danbyte inside a notification."
        htmlFor="delivery-base-url"
      >
        <Input
          id="delivery-base-url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://danbyte.acme.com"
          className="font-mono text-[13px]"
        />
      </SettingsRow>
      <SettingsRow
        label="Webhook timeout"
        hint="Seconds to wait for an outbound call."
        htmlFor="delivery-timeout"
      >
        <Input
          id="delivery-timeout"
          type="number"
          value={timeout}
          onChange={(e) => setWebhookTimeout(e.target.value)}
          className="max-w-28 font-mono text-[13px]"
        />
      </SettingsRow>
      <SettingsRow
        label="Outbound proxy"
        hint="Optional. Used for every outbound notification."
        htmlFor="delivery-proxy"
      >
        <Input
          id="delivery-proxy"
          value={proxy}
          onChange={(e) => setProxy(e.target.value)}
          placeholder="http://proxy:3128"
          className="font-mono text-[13px]"
        />
      </SettingsRow>
    </SettingsCard>
  )
}

function SessionsCard() {
  const { data, save, savingKey } = useDeploymentSettings()
  const [timeout, setTimeoutMins] = useState("0")

  useEffect(() => {
    if (data) setTimeoutMins(String(data.session_idle_timeout_minutes ?? 0))
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
                Every signed-in user - including you - will be logged out and
                must sign in again. API tokens keep working. Use this after a
                suspected compromise or a permissions change.
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

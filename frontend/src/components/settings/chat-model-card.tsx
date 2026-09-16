import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { ChatConnection } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import { SettingsCard } from "@/components/settings/settings-card"
import { FormCheckbox } from "@/components/forms/checkbox"
import { FormSelect } from "@/components/forms/select"
import { FormText } from "@/components/forms/text"

/** Where the in-app chat sends a conversation. Deployment tier: it decides
 * what leaves the network and where the key lives. */
export function ChatModelCard() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ["chat-connection"],
    queryFn: () => api<ChatConnection>("/api/assistant/connection/"),
  })
  const [provider, setProvider] = useState("")
  const [model, setModel] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [verify, setVerify] = useState(true)
  const [key, setKey] = useState("")

  useEffect(() => {
    if (!q.data) return
    setProvider(q.data.ai_provider)
    setModel(q.data.ai_model)
    setBaseUrl(q.data.ai_base_url)
    setVerify(q.data.ai_verify_tls)
  }, [q.data])

  const chosen = q.data?.providers.find((p) => p.kind === provider)

  const save = useMutation({
    mutationFn: () =>
      api<ChatConnection>("/api/assistant/connection/", {
        method: "PUT",
        body: JSON.stringify({
          ai_provider: provider,
          ai_model: model,
          ai_base_url: baseUrl,
          ai_verify_tls: verify,
          ...(key ? { ai_api_key: key } : {}),
        }),
      }),
    onSuccess: () => {
      toast.success("Saved")
      setKey("")
      void qc.invalidateQueries({ queryKey: ["chat-connection"] })
      void qc.invalidateQueries({ queryKey: ["chat-status"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  const test = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; model: string; reply: string }>(
        "/api/assistant/connection/test/",
        { method: "POST" }
      ),
    onSuccess: (r) =>
      toast.success(`${r.model} answered: ${r.reply || "(nothing)"}`),
    onError: (e) => apiErrorToast(e),
  })

  return (
    <SettingsCard
      title="Assistant model"
      description="The chat in the top bar talks to this model. Turn the chat on per tenant under Integrations."
      onSave={() => save.mutate()}
      saving={save.isPending}
      dirty
      footer={
        <Button
          size="sm"
          variant="outline"
          onClick={() => test.mutate()}
          disabled={test.isPending || !provider}
        >
          {test.isPending ? "Testing..." : "Test connection"}
        </Button>
      }
    >
      <FormSelect
        label="Provider"
        value={provider || null}
        onChange={(v) => {
          const next = v ?? ""
          setProvider(next)
          const spec = q.data?.providers.find((p) => p.kind === next)
          if (spec) {
            setModel(spec.default_model)
            setBaseUrl(next === "local" ? spec.default_base_url : "")
          }
        }}
        noneLabel="Not configured"
        options={(q.data?.providers ?? []).map((p) => ({
          value: p.kind,
          label: p.label,
        }))}
      />
      {chosen && <p className="text-xs text-muted-foreground">{chosen.hint}</p>}
      {provider && (
        <>
          <FormText
            label="Model"
            value={model}
            onChange={setModel}
            placeholder={chosen?.default_model}
            mono
          />
          <FormText
            label="Endpoint"
            hint={
              provider === "local"
                ? "Your own model server, for example http://127.0.0.1:11434"
                : "Blank uses the provider's own endpoint."
            }
            value={baseUrl}
            onChange={setBaseUrl}
            placeholder={chosen?.default_base_url}
            mono
          />
          {chosen?.needs_key && (
            <FormText
              label="API key"
              type="password"
              value={key}
              onChange={setKey}
              placeholder={q.data?.ai_api_key_set ? "unchanged" : ""}
              autoComplete="off"
            />
          )}
          <FormCheckbox
            label="Verify the TLS certificate"
            checked={verify}
            onChange={setVerify}
          />
        </>
      )}
    </SettingsCard>
  )
}

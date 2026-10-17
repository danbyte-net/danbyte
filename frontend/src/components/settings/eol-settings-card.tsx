import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { EolSettings } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { timeAgo } from "@/components/cells/time-ago"
import { Button } from "@/components/ui/button"
import { FormCheckbox, FormText } from "@/components/forms"
import { SettingsCard } from "@/components/settings/settings-card"

// End-of-life data (#8): deployment-wide switch, sources, warning window,
// Refresh now, and the offline import for an airgapped install.

export function EolSettingsCard() {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement | null>(null)
  const q = useQuery({
    queryKey: ["eol-settings"],
    queryFn: () => api<EolSettings>("/api/eol/settings/"),
    refetchInterval: (query) => {
      const s = query.state.data?.last_refresh_status
      return s === "queued" || s === "running" ? 2000 : false
    },
  })
  const data = q.data
  const [enabled, setEnabled] = useState(false)
  const [sources, setSources] = useState<string[]>([])
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [days, setDays] = useState("180")

  useEffect(() => {
    if (!data) return
    setEnabled(data.enabled)
    setSources(data.sources ?? [])
    setUrls(data.source_urls ?? {})
    setDays(String(data.warning_days))
  }, [data])

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ["eol-settings"] })
    qc.invalidateQueries({ queryKey: ["platform"] })
  }

  const save = useMutation({
    mutationFn: () =>
      api<EolSettings>("/api/eol/settings/", {
        method: "PATCH",
        body: JSON.stringify({
          enabled,
          sources,
          source_urls: urls,
          warning_days: Number(days),
        }),
      }),
    onSuccess: () => {
      refreshAll()
      toast.success("End-of-life settings saved")
    },
    onError: (e) => apiErrorToast(e),
  })
  const refresh = useMutation({
    mutationFn: () => api("/api/eol/refresh/", { method: "POST" }),
    onSuccess: refreshAll,
    onError: (e) => apiErrorToast(e, "Refresh failed to start"),
  })
  const upload = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData()
      fd.append("file", file)
      return api<{ products: number; changed: number }>("/api/eol/import/", {
        method: "POST",
        body: fd,
      })
    },
    onSuccess: (r) => {
      refreshAll()
      toast.success(`Imported ${r.products} products`)
    },
    onError: (e) => apiErrorToast(e, "Import failed"),
  })

  if (!data?.can_manage) return null
  const dirty =
    enabled !== data.enabled ||
    String(data.warning_days) !== days ||
    JSON.stringify(sources) !== JSON.stringify(data.sources ?? []) ||
    JSON.stringify(urls) !== JSON.stringify(data.source_urls ?? {})
  const running =
    data.last_refresh_status === "queued" ||
    data.last_refresh_status === "running"
  const live = data.enabled && !dirty

  return (
    <SettingsCard
      title="End-of-life data"
      description="Platform end-of-life dates from public sources, for the platform page, the device and VM lists and compliance rules. Off until turned on; nothing is mapped until someone maps a platform."
      onSave={() => save.mutate()}
      dirty={dirty}
      saving={save.isPending}
    >
      <FormCheckbox label="Enabled" checked={enabled} onChange={setEnabled} />
      {(data.available_sources ?? []).map((s) => (
        <div key={s.key} className="grid gap-2">
          <FormCheckbox
            label={s.label}
            checked={sources.includes(s.key)}
            onChange={(on) =>
              setSources((cur) =>
                on ? [...cur, s.key] : cur.filter((k) => k !== s.key)
              )
            }
          />
          <FormText
            label="Source URL"
            mono
            value={urls[s.key] ?? ""}
            onChange={(v) =>
              setUrls((cur) => {
                const next = { ...cur }
                if (v.trim()) next[s.key] = v
                else delete next[s.key]
                return next
              })
            }
            placeholder={s.default_url}
            hint="Blank uses the public service; a mirror goes here"
          />
        </div>
      ))}
      <FormText
        label="Warning window"
        type="number"
        value={days}
        onChange={setDays}
        hint="Days before end of life that read as Support ending"
      />
      <p className="text-sm">
        <span className="num font-medium">{data.products ?? 0}</span> products
        cached · <span className="num font-medium">{data.mappings ?? 0}</span>{" "}
        platforms mapped
        {data.last_refresh_at && (
          <span className="text-muted-foreground">
            {" "}
            · last {data.last_refresh_via === "import"
              ? "import"
              : "refresh"}{" "}
            {timeAgo(data.last_refresh_at)}
          </span>
        )}
        {data.last_refresh_status && (
          <span className="text-muted-foreground">
            {" "}
            · {data.last_refresh_status}
          </span>
        )}
      </p>
      {data.last_refresh_status === "failed" && data.last_refresh_error && (
        <p className="text-sm text-destructive">{data.last_refresh_error}</p>
      )}
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) upload.mutate(f)
          e.target.value = ""
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={!live || running || refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          {running || refresh.isPending ? "Refreshing…" : "Refresh now"}
        </Button>
        <Button
          variant="outline"
          disabled={!live || upload.isPending}
          onClick={() => fileRef.current?.click()}
        >
          {upload.isPending ? "Importing…" : "Import file"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Offline: save{" "}
        <span className="font-mono">
          https://endoflife.date/api/v1/products/full
        </span>{" "}
        on a connected machine and import it here.
      </p>
    </SettingsCard>
  )
}

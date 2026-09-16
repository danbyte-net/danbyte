import { useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { Check, Copy } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  AgentCall,
  AgentClientSnippet,
  AgentConnect,
  AgentSettings,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { usePageTitle } from "@/lib/page-title"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { SimpleTable } from "@/components/ui/simple-table"
import {
  SettingsCard,
  SettingsGrid,
  SettingsHeader,
} from "@/components/settings/settings-card"
import { EmptyState } from "@/components/empty-state"
import { QueryError } from "@/components/query-error"
import { TimeCell } from "@/components/cells/time-ago"
import { Field } from "@/components/forms/field"
import { FormText } from "@/components/forms/text"
import { CheckList } from "@/components/forms/check-list"

export const Route = createFileRoute("/agent-access")({
  component: AgentAccessPage,
})

function AgentAccessPage() {
  usePageTitle("Agent access")
  const { canManage } = useMe()
  const settings = useQuery({
    queryKey: ["agent-settings"],
    queryFn: () => api<AgentSettings>("/api/agent/settings/"),
  })
  const connect = useQuery({
    queryKey: ["agent-connect"],
    queryFn: () => api<AgentConnect>("/api/agent/connect/"),
  })

  if (settings.error) return <QueryError error={settings.error} />
  const data = settings.data
  if (!data) return <p className="text-sm text-muted-foreground">Loading...</p>

  return (
    // A top-level route, so it owns its own padding AND its own scroll -
    // settings pages get both from the settings layout, and the root shell
    // clips anything past the viewport.
    <div className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-6">
      <div className="max-w-5xl space-y-4">
        <SettingsHeader title="Agent access">
          An assistant reaches this tenant through the Model Context Protocol
          with an API token, and sees exactly what that account sees.
        </SettingsHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={data.enabled ? "success" : "secondary"}>
            {data.enabled ? "On" : "Off"}
          </Badge>
          <Badge variant={data.writes_enabled ? "warning" : "secondary"}>
            {data.writes_enabled ? "Reading and writing" : "Reading only"}
          </Badge>
          <Link to="/settings/integrations" className="link text-xs">
            Change in Settings → Integrations
          </Link>
        </div>

        <ConnectCard connect={connect.data} />
        <SettingsGrid>
          <LimitsCard settings={data} canManage={canManage} />
          <TokenCard />
        </SettingsGrid>
        <CallsCard canManage={canManage} />
      </div>
    </div>
  )
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          toast.success(`${label} copied`)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  )
}

function ConnectCard({ connect }: { connect: AgentConnect | undefined }) {
  const clients = connect?.clients ?? []
  const [which, setWhich] = useState("claude-code")
  const chosen: AgentClientSnippet | undefined =
    clients.find((c) => c.id === which) ?? clients.at(0)

  return (
    <SettingsCard
      title="Connect an assistant"
      description="Create a token first, then paste this into your client. Keep the token out of anything you commit."
    >
      {clients.length === 0 ? (
        <p className="text-xs text-muted-foreground">Loading...</p>
      ) : (
        <>
          <SegmentedTabs
            value={chosen ? chosen.id : which}
            onValueChange={setWhich}
            items={clients.map((c) => ({ value: c.id, label: c.label }))}
          />
          {chosen && (
            <div className="space-y-2">
              {chosen.path && (
                <p className="text-xs text-muted-foreground">
                  Add this to <span className="font-mono">{chosen.path}</span>.
                </p>
              )}
              <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs">
                {chosen.snippet}
              </pre>
              <div className="flex items-center gap-2">
                <CopyButton text={chosen.snippet} label={chosen.label} />
                <span className="text-xs text-muted-foreground">
                  Endpoint <span className="font-mono">{connect?.url}</span>
                </span>
              </div>
            </div>
          )}
        </>
      )}
    </SettingsCard>
  )
}

function TokenCard() {
  return (
    <SettingsCard
      title="Tokens"
      description="An assistant is only as capable as the token you give it."
    >
      <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
        <li>
          A read-only token can never change anything, whatever the assistant is
          asked to do.
        </li>
        <li>
          The token's own permissions decide what it sees. Give an assistant a
          narrow account rather than your own.
        </li>
        <li>Revoke a token to cut an assistant off immediately.</li>
      </ul>
      <Button size="sm" variant="outline" asChild>
        <Link to="/settings/preferences">Manage API tokens</Link>
      </Button>
    </SettingsCard>
  )
}

function LimitsCard({
  settings,
  canManage,
}: {
  settings: AgentSettings
  canManage: boolean
}) {
  const qc = useQueryClient()
  const [maxRows, setMaxRows] = useState(String(settings.max_rows))
  const [types, setTypes] = useState<string[]>(settings.allowed_types)

  const save = useMutation({
    mutationFn: () =>
      api<AgentSettings>("/api/agent/settings/", {
        method: "PUT",
        body: JSON.stringify({
          max_rows: Number(maxRows) || 50,
          allowed_types: types,
        }),
      }),
    onSuccess: () => {
      toast.success("Saved")
      void qc.invalidateQueries({ queryKey: ["agent-settings"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <SettingsCard
      title="Limits"
      description="What an assistant may reach, and how much of it at a time."
      onSave={canManage ? () => save.mutate() : undefined}
      saving={save.isPending}
      dirty
    >
      <FormText
        label="Rows per answer"
        hint="An assistant is told when a result was cut short."
        type="number"
        min={1}
        max={500}
        value={maxRows}
        onChange={setMaxRows}
        disabled={!canManage}
      />
      <Field
        label="Object types"
        hint="Nothing selected means every type the token's own permissions already allow."
      >
        <CheckList
          options={settings.known_types.map((t) => ({ value: t, label: t }))}
          value={types}
          onChange={setTypes}
          className="max-h-64"
        />
      </Field>
    </SettingsCard>
  )
}

const CALLS_PER_PAGE = 25

function CallsCard({ canManage }: { canManage: boolean }) {
  const [page, setPage] = useState(1)
  const offset = (page - 1) * CALLS_PER_PAGE
  const calls = useQuery({
    queryKey: ["agent-calls", page],
    queryFn: () =>
      api<{ results: AgentCall[]; count: number }>(
        `/api/agent/calls/?limit=${CALLS_PER_PAGE}&offset=${offset}`
      ),
    enabled: canManage,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  })
  const total = calls.data?.count ?? 0
  const pages = Math.max(1, Math.ceil(total / CALLS_PER_PAGE))

  if (!canManage) return null
  return (
    <SettingsCard
      title="Recent calls"
      description="Every question an assistant asked, and what came back."
      badge={
        calls.data ? (
          <Badge variant="secondary">{calls.data.count}</Badge>
        ) : null
      }
    >
      {calls.error ? (
        <QueryError error={calls.error} />
      ) : (calls.data?.results.length ?? 0) === 0 ? (
        <EmptyState title="Nothing yet">
          Calls appear here as soon as an assistant connects.
        </EmptyState>
      ) : (
        <SimpleTable
          columns={[
            {
              id: "when",
              header: "When",
              cell: (c: AgentCall) => <TimeCell iso={c.created_at} />,
            },
            {
              id: "tool",
              header: "Asked for",
              cell: (c: AgentCall) => (
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-xs">{c.tool}</span>
                  {c.object_type && (
                    <Badge variant="secondary">{c.object_type}</Badge>
                  )}
                  {c.wrote && <Badge variant="warning">wrote</Badge>}
                </span>
              ),
            },
            {
              id: "as",
              header: "As",
              flex: true,
              cell: (c: AgentCall) => (
                <span className="text-xs">
                  {c.user_name ?? "-"}
                  {c.token_name && (
                    <span className="text-muted-foreground">
                      {" "}
                      · {c.token_name}
                    </span>
                  )}
                </span>
              ),
            },
            {
              id: "rows",
              header: "Rows",
              align: "right",
              cell: (c: AgentCall) => (
                <span className="tabular-nums">{c.rows}</span>
              ),
            },
            {
              id: "ms",
              header: "Took",
              align: "right",
              cell: (c: AgentCall) => (
                <span className="tabular-nums">{c.ms} ms</span>
              ),
            },
            {
              id: "outcome",
              header: "Outcome",
              cell: (c: AgentCall) =>
                c.error ? (
                  <span className="text-xs text-destructive">{c.error}</span>
                ) : (
                  <Badge variant="success">ok</Badge>
                ),
            },
          ]}
          data={calls.data?.results ?? []}
          getRowKey={(c) => c.id}
        />
      )}
      {pages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="num">
            {offset + 1}-{Math.min(offset + CALLS_PER_PAGE, total)} of {total}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <span className="num">
              Page {page} of {pages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </SettingsCard>
  )
}

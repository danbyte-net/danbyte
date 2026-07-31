import { useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { GitCompareArrows, Upload, X } from "lucide-react"
import { toast } from "sonner"

import { api, apiStatus } from "@/lib/api"
import type { Paginated, SSHHostKey } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Section } from "@/components/ui/section"
import { SimpleTable } from "@/components/ui/simple-table"
import type { SimpleColumn } from "@/components/ui/simple-table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field } from "@/components/forms/field"
import { QueryError } from "@/components/query-error"
import { CopyButton } from "@/components/kv-card"
import { TimeCell } from "@/components/cells/time-ago"
import { dash } from "@/components/cells/dash"

const ORIGIN_LABEL: Record<SSHHostKey["origin"], string> = {
  observed: "Observed",
  uploaded: "Expected",
  both: "Expected · seen",
}

// A firing ssh_host_key_mismatch alert names the device that is presenting a
// key no expected key of its type matches.
interface MismatchDetail {
  drift?: string
  device?: string
  key_type?: string
  served?: string
  expected?: string[]
}
interface RawAlert {
  id: string
  kind: string
  status: string
  detail: MismatchDetail | null
}

/**
 * SSH host keys for one device: the keys it is **expected** to present
 * (uploaded), the keys actually **observed** on the wire, drift when the two
 * disagree (`ssh_host_key_mismatch`) with an Accept action, and paste-to-add.
 * Device-scoped — a host key belongs to its device, so there is no assignment
 * step (unlike certificates).
 */
export function SSHHostKeysPanel({ deviceId }: { deviceId: string }) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canManage = canDo("monitoring.sshhostkey", "add")
  const [uploadOpen, setUploadOpen] = useState(false)

  const keys = useQuery({
    queryKey: ["ssh-host-keys", deviceId],
    queryFn: () =>
      api<Paginated<SSHHostKey>>(
        `/api/monitoring/ssh-host-keys/?device=${deviceId}`
      ),
  })

  const alerts = useQuery({
    queryKey: ["ssh-host-key-alerts", deviceId],
    queryFn: () =>
      api<Paginated<RawAlert> | RawAlert[]>(
        "/api/monitoring/alerts/?status=firing"
      ),
  })
  const alertRows = Array.isArray(alerts.data)
    ? alerts.data
    : (alerts.data?.results ?? [])
  const mismatches = alertRows.filter(
    (a) =>
      a.kind === "ssh" &&
      a.detail?.drift === "ssh_host_key_mismatch" &&
      a.detail?.device === deviceId
  )

  const accept = useMutation({
    mutationFn: (id: string) =>
      api(`/api/monitoring/ssh-host-keys/${id}/accept-observed/`, {
        method: "POST",
      }),
    onSuccess: () => {
      toast.success("Accepted as the expected host key")
      qc.invalidateQueries({ queryKey: ["ssh-host-keys", deviceId] })
      qc.invalidateQueries({ queryKey: ["ssh-host-key-alerts", deviceId] })
    },
    onError: apiErrorToast,
  })

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/monitoring/ssh-host-keys/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Host key removed")
      qc.invalidateQueries({ queryKey: ["ssh-host-keys", deviceId] })
      qc.invalidateQueries({ queryKey: ["ssh-host-key-alerts", deviceId] })
    },
    onError: apiErrorToast,
  })

  const columns: SimpleColumn<SSHHostKey>[] = [
    {
      id: "type",
      header: "Type",
      cell: (k) => <span className="font-mono text-xs">{k.key_type}</span>,
    },
    {
      id: "fingerprint",
      header: "Fingerprint",
      flex: true,
      cell: (k) => (
        <span className="inline-flex items-center gap-1">
          <span className="font-mono text-[11px] break-all">
            {k.fingerprint_sha256}
          </span>
          <CopyButton value={k.fingerprint_sha256} />
        </span>
      ),
    },
    { id: "comment", header: "Comment", cell: (k) => k.comment || dash },
    {
      id: "origin",
      header: "Origin",
      cell: (k) => (
        <Badge variant="secondary" className="text-xs">
          {ORIGIN_LABEL[k.origin]}
        </Badge>
      ),
    },
    {
      id: "last_seen",
      header: "Last seen",
      cell: (k) => (k.last_seen ? <TimeCell iso={k.last_seen} /> : dash),
    },
    {
      id: "actions",
      header: "",
      cell: (k) =>
        canManage ? (
          <div className="flex justify-end gap-1">
            {k.observed && !k.uploaded && (
              <Button
                size="sm"
                variant="outline"
                disabled={accept.isPending}
                onClick={() => accept.mutate(k.id)}
              >
                Accept
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              disabled={remove.isPending}
              onClick={() => remove.mutate(k.id)}
              aria-label="Remove host key"
            >
              <X className="size-4" />
            </Button>
          </div>
        ) : null,
    },
  ]

  return (
    <Section
      title="SSH host keys"
      description="the key the device is expected to present on port 22, and what's observed"
      actions={
        canManage ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setUploadOpen(true)}
          >
            <Upload className="h-3.5 w-3.5" /> Add host key
          </Button>
        ) : undefined
      }
    >
      {mismatches.length > 0 && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <GitCompareArrows className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <div>
            <div className="font-medium">Host key drift</div>
            <div className="text-muted-foreground">
              This device is presenting a key that isn't the expected one.
              Accept the observed key below if the change is legitimate.
            </div>
          </div>
        </div>
      )}

      {keys.isError ? (
        <QueryError error={keys.error} />
      ) : (
        <SimpleTable
          columns={columns}
          data={keys.data?.results ?? []}
          getRowKey={(k) => k.id}
          empty="No host keys recorded yet. Add the expected key, or run an SSH check to observe one."
        />
      )}

      <UploadSSHHostKeyDialog
        deviceId={deviceId}
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onDone={() => {
          qc.invalidateQueries({ queryKey: ["ssh-host-keys", deviceId] })
          qc.invalidateQueries({ queryKey: ["ssh-host-key-alerts", deviceId] })
        }}
      />
    </Section>
  )
}

function UploadSSHHostKeyDialog({
  deviceId,
  open,
  onOpenChange,
  onDone,
}: {
  deviceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [line, setLine] = useState("")
  const fileRef = useRef<HTMLInputElement>(null)

  const reset = () => {
    setLine("")
    if (fileRef.current) fileRef.current.value = ""
  }

  const upload = useMutation({
    mutationFn: () =>
      apiStatus<SSHHostKey>("/api/monitoring/ssh-host-keys/", {
        method: "POST",
        body: JSON.stringify({
          device: deviceId,
          public_key_line: line.trim(),
        }),
      }),
    onSuccess: ({ status }) => {
      toast.success(
        status === 200
          ? "Matched an already-observed key — now marked expected too"
          : "Host key added"
      )
      onDone()
      reset()
      onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })

  const onFile = (file: File | undefined) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setLine(String(reader.result ?? "").trim())
    reader.onerror = () => toast.error("Couldn't read that file")
    reader.readAsText(file)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Add SSH host key</DialogTitle>
          <DialogDescription>
            Paste the device's public host key (an OpenSSH line like{" "}
            <code>ssh-ed25519 AAAA… host</code>), or load a <code>.pub</code>{" "}
            file. Only the public key is stored — never a private key.
          </DialogDescription>
        </DialogHeader>

        <Field label="Public key" hint="One OpenSSH public-key line">
          <div className="space-y-2">
            <textarea
              value={line}
              onChange={(e) => setLine(e.target.value)}
              rows={4}
              spellCheck={false}
              placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA… host"
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[12px] shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
            <div>
              <input
                ref={fileRef}
                type="file"
                accept=".pub,text/plain"
                className="hidden"
                onChange={(e) => onFile(e.target.files?.[0])}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileRef.current?.click()}
              >
                <Upload className="h-3.5 w-3.5" /> Load from file…
              </Button>
            </div>
          </div>
        </Field>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!line.trim() || upload.isPending}
            onClick={() => upload.mutate()}
          >
            {upload.isPending ? "Adding…" : "Add host key"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

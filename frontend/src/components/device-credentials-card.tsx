import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Eye, KeyRound, Pencil, Plus, Trash2 } from "lucide-react"

import { api } from "@/lib/api"
import type { Paginated } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  FormCheckbox,
  FormFooter,
  FormRow,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"

interface DeviceCredential {
  id: string
  name: string
  kind: "ssh_password" | "ssh_key" | "https_login"
  username: string
  port: number | null
  secret_managed: boolean
  secret_provider: string
  secret_path: string
  secret_set: boolean
}

const KINDS = [
  { value: "ssh_password", label: "SSH password" },
  { value: "ssh_key", label: "SSH key" },
  { value: "https_login", label: "HTTPS login" },
]
const KIND_LABEL: Record<string, string> = Object.fromEntries(
  KINDS.map((k) => [k.value, k.label])
)

/** The device's login credentials — each references a secret Danbyte stores in
 * the configured secret manager (managed) or an external path the operator keeps
 * themselves. Secrets are never shown in the list; the Reveal action (gated on
 * the reveal verb) fetches one on demand. */
export function DeviceCredentialsCard({ deviceId }: { deviceId: string }) {
  const { canDo } = useMe()
  const canView = canDo("devicecredential", "view")
  const canAdd = canDo("devicecredential", "add")
  const canChange = canDo("devicecredential", "change")
  const canDelete = canDo("devicecredential", "delete")
  const canReveal = canDo("devicecredential", "reveal")

  const [editing, setEditing] = useState<DeviceCredential | null>(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<DeviceCredential | null>(null)

  const q = useQuery({
    queryKey: ["device-credentials", deviceId],
    queryFn: () =>
      api<Paginated<DeviceCredential>>(
        `/api/monitoring/device-credentials/?device=${deviceId}`
      ),
    enabled: canView,
  })

  if (!canView) return null
  const rows = q.data?.results ?? []

  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <KeyRound className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Credentials</h3>
        <Badge variant="secondary">{rows.length}</Badge>
        {canAdd && (
          <Button size="sm" className="ml-auto" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Add credential
          </Button>
        )}
      </div>
      {q.isLoading ? (
        <p className="p-4 text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          No credentials yet. Add one so this device can be reached from Connect
          or the SSH terminal.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{c.name}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {KIND_LABEL[c.kind] ?? c.kind}
                  </Badge>
                  {!c.secret_managed && (
                    <Badge variant="secondary" className="text-[10px]">
                      external
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {c.username || "—"}
                  {c.port ? `:${c.port}` : ""}
                </div>
              </div>
              <div className="ml-auto flex items-center gap-1">
                {canReveal && c.secret_set && (
                  <RevealButton id={c.id} />
                )}
                {canChange && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    onClick={() => setEditing(c)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                )}
                {canDelete && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-destructive hover:text-destructive"
                    onClick={() => setDeleting(c)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {(adding || editing) && (
        <CredentialForm
          deviceId={deviceId}
          credential={editing}
          onClose={() => {
            setAdding(false)
            setEditing(null)
          }}
        />
      )}
      <DeleteDialog
        credential={deleting}
        onClose={() => setDeleting(null)}
      />
    </div>
  )
}

function RevealButton({ id }: { id: string }) {
  const [value, setValue] = useState<Record<string, unknown> | null>(null)
  const reveal = useMutation({
    mutationFn: () =>
      api<{ secret: Record<string, unknown> }>(
        `/api/monitoring/device-credentials/${id}/reveal/`,
        { method: "POST" }
      ),
    onSuccess: (r) => setValue(r.secret),
    onError: (e) => apiErrorToast(e, "Couldn't reveal the secret"),
  })
  return (
    <>
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8"
        title="Reveal secret"
        onClick={() => reveal.mutate()}
      >
        <Eye className="h-3.5 w-3.5" />
      </Button>
      <AlertDialog open={value != null} onOpenChange={(o) => !o && setValue(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revealed secret</AlertDialogTitle>
            <AlertDialogDescription>
              This disclosure is recorded in the change log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs">
            {value ? JSON.stringify(value, null, 2) : ""}
          </pre>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setValue(null)}>
              Close
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function CredentialForm({
  deviceId,
  credential,
  onClose,
}: {
  deviceId: string
  credential: DeviceCredential | null
  onClose: () => void
}) {
  const isEdit = !!credential
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState("")
  const [kind, setKind] = useState<DeviceCredential["kind"]>("ssh_password")
  const [username, setUsername] = useState("")
  const [port, setPort] = useState("")
  const [managed, setManaged] = useState(true)
  const [password, setPassword] = useState("")
  const [privateKey, setPrivateKey] = useState("")
  const [passphrase, setPassphrase] = useState("")
  const [provider, setProvider] = useState<"local" | "vault">("local")
  const [path, setPath] = useState("")

  useEffect(() => {
    setName(credential?.name ?? "")
    setKind(credential?.kind ?? "ssh_password")
    setUsername(credential?.username ?? "")
    setPort(credential?.port != null ? String(credential.port) : "")
    setManaged(credential?.secret_managed ?? true)
    setPassword("")
    setPrivateKey("")
    setPassphrase("")
    setProvider((credential?.secret_provider as "local" | "vault") || "local")
    setPath(credential?.secret_path ?? "")
    reset()
  }, [credential, reset])

  const mutation = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = {
        device: deviceId,
        name: name.trim(),
        kind,
        username: username.trim(),
        port: port.trim() === "" ? null : Number(port),
        secret_managed: managed,
      }
      if (managed) {
        // Only send the fields relevant to the kind; blanks on edit keep the
        // stored secret untouched.
        if (kind === "ssh_key") {
          if (privateKey) payload.private_key = privateKey
          if (passphrase) payload.passphrase = passphrase
        } else if (password) {
          payload.password = password
        }
      } else {
        payload.secret_provider = provider
        payload.secret_path = path.trim()
      }
      const base = "/api/monitoring/device-credentials/"
      return isEdit
        ? api(`${base}${credential.id}/`, {
            method: "PATCH",
            body: JSON.stringify(payload),
          })
        : api(base, { method: "POST", body: JSON.stringify(payload) })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["device-credentials", deviceId] })
      toast.success(isEdit ? "Credential updated" : "Credential added")
      onClose()
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const secretHint = useMemo(
    () =>
      isEdit
        ? "Leave blank to keep the stored secret."
        : "Stored in the configured secret manager (local or Vault).",
    [isEdit]
  )

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEdit ? `Edit ${credential.name}` : "Add credential"}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            mutation.mutate()
          }}
          className="grid gap-4"
        >
          <FormText
            label="Name"
            required
            autoFocus={!isEdit}
            value={name}
            onChange={setName}
            placeholder="admin login"
            error={fieldErrors.name}
          />
          <FormRow>
            <FormSelect
              label="Kind"
              value={kind}
              onChange={(v) => setKind((v as DeviceCredential["kind"]) ?? "ssh_password")}
              options={KINDS}
            />
            <FormText
              label="Username"
              value={username}
              onChange={setUsername}
              placeholder="netadmin"
              error={fieldErrors.username}
            />
          </FormRow>
          <FormRow>
            <FormText
              label="Port"
              type="number"
              value={port}
              onChange={setPort}
              placeholder={kind === "https_login" ? "443" : "22"}
              error={fieldErrors.port}
            />
            <div />
          </FormRow>

          <FormCheckbox
            label="Store the secret in Danbyte's secret manager"
            hint="On: type the secret here and Danbyte keeps it in the configured store (local or Vault). Off: reference an existing external path you manage yourself."
            checked={managed}
            onChange={setManaged}
          />

          {managed ? (
            kind === "ssh_key" ? (
              <>
                <FormTextarea
                  label="Private key"
                  value={privateKey}
                  onChange={setPrivateKey}
                  rows={5}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  hint={secretHint}
                  error={fieldErrors.private_key}
                />
                <FormText
                  label="Passphrase"
                  type="password"
                  value={passphrase}
                  onChange={setPassphrase}
                  error={fieldErrors.passphrase}
                />
              </>
            ) : (
              <FormText
                label="Password"
                type="password"
                value={password}
                onChange={setPassword}
                hint={secretHint}
                error={fieldErrors.password}
              />
            )
          ) : (
            <FormRow>
              <FormSelect
                label="Store"
                value={provider}
                onChange={(v) => setProvider((v as "local" | "vault") ?? "local")}
                options={[
                  { value: "local", label: "Local" },
                  { value: "vault", label: "Vault" },
                ]}
              />
              <FormText
                label="Path"
                mono
                value={path}
                onChange={setPath}
                placeholder="kv/data/team/ssh"
                error={fieldErrors.secret_path}
              />
            </FormRow>
          )}

          <FormFooter
            onCancel={onClose}
            submitting={mutation.isPending}
            submitLabel={isEdit ? "Save changes" : "Add credential"}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DeleteDialog({
  credential,
  onClose,
}: {
  credential: DeviceCredential | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  const del = useMutation({
    mutationFn: () =>
      api(`/api/monitoring/device-credentials/${credential!.id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["device-credentials"] })
      toast.success("Credential deleted")
      onClose()
    },
    onError: (e) => apiErrorToast(e, "Couldn't delete the credential"),
  })
  return (
    <AlertDialog open={credential != null} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {credential?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the reference. A managed secret is also deleted from the
            store; an external one is left in place.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault()
              del.mutate()
            }}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {del.isPending ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

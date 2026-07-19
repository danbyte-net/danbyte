import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Pencil, Trash2 } from "lucide-react"

import { api, type Paginated, type SnmpProfileOption } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FormCheckbox } from "@/components/forms"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { QueryError } from "@/components/query-error"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/settings/snmp")({
  component: SnmpProfilesPage,
})

type Version = "v1" | "v2c" | "v3"

function SnmpProfilesPage() {
  // Every other settings page guards in-component; this one relied on the
  // hidden nav link + backend RBAC only — close the gap.
  const { canManage, isLoading: meLoading } = useMe()
  const qc = useQueryClient()
  const list = useQuery({
    queryKey: ["snmp-profiles"],
    queryFn: () =>
      api<Paginated<SnmpProfileOption>>("/api/monitoring/snmp-profiles/"),
  })

  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [version, setVersion] = useState<Version>("v2c")
  const [community, setCommunity] = useState("")
  const [username, setUsername] = useState("")
  const [authProto, setAuthProto] = useState("sha")
  const [authKey, setAuthKey] = useState("")
  const [privProto, setPrivProto] = useState("aes")
  const [privKey, setPrivKey] = useState("")
  const [isDefault, setIsDefault] = useState(false)

  const reset = () => {
    setEditingId(null)
    setName("")
    setCommunity("")
    setUsername("")
    setAuthKey("")
    setPrivKey("")
    setIsDefault(false)
    setVersion("v2c")
    setAuthProto("sha")
    setPrivProto("aes")
  }

  const startEdit = (p: SnmpProfileOption) => {
    setEditingId(p.id)
    setName(p.name)
    setVersion((p.version as Version) || "v2c")
    setIsDefault(p.is_default)
    // Non-secret v3 params can be pre-filled; secrets are write-only, so the key
    // fields stay blank and are only sent when the user types a new value.
    setUsername(p.params?.username ?? "")
    setAuthProto(p.params?.auth_proto ?? "sha")
    setPrivProto(p.params?.priv_proto ?? "aes")
    setCommunity("")
    setAuthKey("")
    setPrivKey("")
    if (typeof window !== "undefined")
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" })
  }

  const save = useMutation({
    mutationFn: () => {
      const params: Record<string, unknown> = {}
      const secret_params: Record<string, unknown> = {}
      if (version === "v3") {
        params.username = username
        params.auth_proto = authProto
        params.priv_proto = privProto
        if (authKey) secret_params.auth_key = authKey
        if (privKey) secret_params.priv_key = privKey
      } else if (community) {
        secret_params.community = community
      }
      const body: Record<string, unknown> = {
        name,
        version,
        params,
        is_default: isDefault,
      }
      // Only send secrets when the user actually entered one — otherwise an edit
      // would wipe the encrypted credential. (On create, v2c needs a community.)
      if (Object.keys(secret_params).length > 0)
        body.secret_params = secret_params
      return editingId
        ? api<SnmpProfileOption>(
            `/api/monitoring/snmp-profiles/${editingId}/`,
            {
              method: "PATCH",
              body: JSON.stringify(body),
            }
          )
        : api<SnmpProfileOption>("/api/monitoring/snmp-profiles/", {
            method: "POST",
            body: JSON.stringify({ ...body, secret_params }),
          })
    },
    onSuccess: () => {
      toast.success(editingId ? "SNMP profile updated" : "SNMP profile created")
      qc.invalidateQueries({ queryKey: ["snmp-profiles"] })
      reset()
    },
    onError: (e) => apiErrorToast(e),
  })

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/monitoring/snmp-profiles/${id}/`, { method: "DELETE" }),
    onSuccess: (_d, id) => {
      toast.success("Profile deleted")
      if (editingId === id) reset()
      qc.invalidateQueries({ queryKey: ["snmp-profiles"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  const profiles = list.data?.results ?? []

  if (meLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (!canManage)
    return (
      <p className="text-sm text-muted-foreground">Tenant admin required.</p>
    )

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h2 className="text-sm font-semibold">SNMP profiles</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Reusable SNMP credentials for polling device facts. Credentials are
          encrypted at rest and never shown again after saving — when editing,
          leave a key blank to keep the existing one.
        </p>
      </div>

      <section className="rounded-lg border border-border">
        {list.isError && (
          <div className="p-4">
            <QueryError error={list.error} />
          </div>
        )}
        {profiles.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No profiles yet — create one below.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {profiles.map((p) => (
              <li
                key={p.id}
                className={
                  "flex items-center gap-3 px-4 py-2.5 text-sm" +
                  (editingId === p.id ? " bg-muted/50" : "")
                }
              >
                <span className="font-medium">{p.name}</span>
                <Badge variant="secondary">{p.version}</Badge>
                {p.is_default && <Badge variant="success">default</Badge>}
                {!p.has_secrets && (
                  <Badge variant="destructive">no credentials</Badge>
                )}
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => startEdit(p)}
                    aria-label={`Edit ${p.name}`}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(p.id)}
                    aria-label={`Delete ${p.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-4 rounded-lg border border-border p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            {editingId ? "Edit profile" : "Add a profile"}
          </h3>
          {editingId && (
            <Button size="sm" variant="ghost" onClick={reset}>
              Cancel
            </Button>
          )}
        </div>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (name) save.mutate()
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Prod read-only"
              />
            </Field>
            <Field label="Version">
              <Select
                value={version}
                onValueChange={(v) => setVersion(v as Version)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="v2c">v2c</SelectItem>
                  <SelectItem value="v1">v1</SelectItem>
                  <SelectItem value="v3">v3</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          {version === "v3" ? (
            <div className="grid gap-3">
              <Field label="Username">
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Auth protocol">
                  <Select value={authProto} onValueChange={setAuthProto}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {["sha", "sha256", "sha512", "md5"].map((p) => (
                        <SelectItem key={p} value={p}>
                          {p}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field
                  label={editingId ? "Auth key (blank = keep)" : "Auth key"}
                >
                  <Input
                    type="password"
                    value={authKey}
                    onChange={(e) => setAuthKey(e.target.value)}
                  />
                </Field>
                <Field label="Privacy protocol">
                  <Select value={privProto} onValueChange={setPrivProto}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {["aes", "aes256", "des"].map((p) => (
                        <SelectItem key={p} value={p}>
                          {p}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field
                  label={
                    editingId ? "Privacy key (blank = keep)" : "Privacy key"
                  }
                >
                  <Input
                    type="password"
                    value={privKey}
                    onChange={(e) => setPrivKey(e.target.value)}
                  />
                </Field>
              </div>
            </div>
          ) : (
            <Field label={editingId ? "Community (blank = keep)" : "Community"}>
              <Input
                type="password"
                value={community}
                onChange={(e) => setCommunity(e.target.value)}
                placeholder="public"
              />
            </Field>
          )}

          <FormCheckbox
            label="Default profile"
            checked={isDefault}
            onChange={setIsDefault}
            hint="Used when a device poll doesn't name a profile."
          />

          <div className="flex justify-end gap-2">
            {editingId && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={reset}
              >
                Cancel
              </Button>
            )}
            <Button type="submit" size="sm" disabled={save.isPending || !name}>
              {save.isPending
                ? "Saving…"
                : editingId
                  ? "Save changes"
                  : "Create profile"}
            </Button>
          </div>
        </form>
      </section>
    </div>
  )
}

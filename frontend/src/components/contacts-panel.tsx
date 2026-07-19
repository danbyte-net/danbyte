import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Plus, X } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  ContactAssignment,
  ContactMini,
  ContactPriority,
  ContactRoleOption,
  Paginated,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Section } from "@/components/ui/section"
import { SimpleTable } from "@/components/ui/simple-table"
import type { SimpleColumn } from "@/components/ui/simple-table"
import { Combobox } from "@/components/ui/combobox"
import type { ComboboxOption } from "@/components/ui/combobox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { QueryError } from "@/components/query-error"
import { apiErrorToast } from "@/lib/api-toast"

const PRIORITIES: { value: ContactPriority; label: string }[] = [
  { value: "primary", label: "Primary" },
  { value: "secondary", label: "Secondary" },
  { value: "tertiary", label: "Tertiary" },
  { value: "inactive", label: "Inactive" },
]

/**
 * Per-object contacts — lists the contacts attached to one object (by the
 * `object_type` label + `object_id` convention) and lets the user attach a
 * contact in a role at a priority, or detach one. Drop into any detail page.
 */
export function ContactsPanel({
  objectType,
  objectId,
}: {
  objectType: string
  objectId: string
}) {
  const qc = useQueryClient()
  const key = ["contact-assignments", objectType, objectId]
  const [contactId, setContactId] = useState<string | null>(null)
  const [roleId, setRoleId] = useState<string | null>(null)
  const [priority, setPriority] = useState<ContactPriority>("primary")

  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      api<Paginated<ContactAssignment>>(
        `/api/contact-assignments/?object_type=${objectType}&object_id=${objectId}&page_size=500`
      ),
  })
  const contacts = useQuery({
    queryKey: ["contacts-picker"],
    queryFn: () => api<Paginated<ContactMini>>("/api/contacts/?picker=1"),
    staleTime: 5 * 60_000,
  })
  const roles = useQuery({
    queryKey: ["contact-roles-picker"],
    queryFn: () =>
      api<Paginated<ContactRoleOption>>("/api/contact-roles/?picker=1"),
    staleTime: 10 * 60_000,
  })

  const contactOptions = useMemo<ComboboxOption[]>(
    () =>
      (contacts.data?.results ?? []).map((c) => ({
        value: c.id,
        label: c.title ? `${c.name} · ${c.title}` : c.name,
      })),
    [contacts.data]
  )

  const refresh = () => qc.invalidateQueries({ queryKey: key })

  const add = useMutation({
    mutationFn: () =>
      api(`/api/contact-assignments/`, {
        method: "POST",
        body: JSON.stringify({
          contact_id: contactId,
          role_id: roleId,
          object_type: objectType,
          object_id: objectId,
          priority,
        }),
      }),
    onSuccess: () => {
      toast.success("Contact attached")
      setContactId(null)
      setRoleId(null)
      setPriority("primary")
      refresh()
    },
    onError: (err) => apiErrorToast(err),
  })

  const remove = useMutation({
    mutationFn: (aid: string) =>
      api<void>(`/api/contact-assignments/${aid}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Contact detached")
      refresh()
    },
    onError: (err) => apiErrorToast(err),
  })

  const rows = q.data?.results ?? []

  const columns: SimpleColumn<ContactAssignment>[] = [
    {
      id: "contact",
      header: "Contact",
      cell: (a) => (
        <Link
          to="/contacts/$id"
          params={{ id: a.contact.id }}
          className="font-medium text-primary hover:underline"
        >
          {a.contact.name}
        </Link>
      ),
    },
    {
      id: "email",
      header: "Email",
      flex: true,
      cell: (a) =>
        a.contact.email ? (
          <a
            href={`mailto:${a.contact.email}`}
            className="font-mono text-xs text-muted-foreground hover:text-primary"
          >
            {a.contact.email}
          </a>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "role",
      header: "Role",
      cell: (a) =>
        a.role ? (
          <span className="text-xs">{a.role.name}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "priority",
      header: "Priority",
      cell: (a) => (
        <span className="text-xs capitalize">{a.priority_display}</span>
      ),
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (a) => (
        <button
          type="button"
          onClick={() => remove.mutate(a.id)}
          disabled={remove.isPending}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
          aria-label="Detach contact"
          title="Detach contact"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ),
    },
  ]

  return (
    <Section title="Contacts" count={rows.length}>
      <div className="max-w-3xl space-y-3">
        {q.isError && <QueryError error={q.error} />}
        <SimpleTable
          columns={columns}
          data={rows}
          getRowKey={(a) => a.id}
          empty="No contacts attached."
        />

        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-50 flex-1">
            <Combobox
              value={contactId}
              onChange={setContactId}
              options={contactOptions}
              placeholder="Attach a contact…"
              searchPlaceholder="Search contacts…"
            />
          </div>
          <Select
            value={roleId ?? "__none__"}
            onValueChange={(v) => setRoleId(v === "__none__" ? null : v)}
          >
            <SelectTrigger className="h-9 w-36">
              <SelectValue placeholder="Role" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">No role</SelectItem>
              {roles.data?.results.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={priority}
            onValueChange={(v) => setPriority(v as ContactPriority)}
          >
            <SelectTrigger className="h-9 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRIORITIES.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            disabled={!contactId || add.isPending}
            onClick={() => add.mutate()}
          >
            <Plus className="h-3.5 w-3.5" /> Attach
          </Button>
        </div>
      </div>
    </Section>
  )
}

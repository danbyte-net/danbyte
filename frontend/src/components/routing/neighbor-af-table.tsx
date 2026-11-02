import { useMemo, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"

import type { AfiSafi, BGPNeighborAF } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DataTable } from "@/components/data-table"
import {
  FormCheckbox,
  FormCombobox,
  FormFooter,
  FormSection,
  FormSelect,
  FormText,
} from "@/components/forms"
import { buildNeighborAFColumns } from "@/components/columns/routing-columns"

import { AFI_SAFI } from "./bgp-forms"
import { RoutingDeleteDialog } from "./catalog-page"
import {
  ROUTING_OBJECT_TYPES,
  numOrNull,
  numText,
  usePickList,
  useRoutingSave,
} from "./form-bits"

// A neighbour's address families, one row each, with the policies and knobs
// that apply in that family only. Blank inherits: the session's own field,
// then the peer group's row, then the group's field.

const TRI = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
]
const triFrom = (v: boolean | null | undefined) =>
  v == null ? null : v ? "on" : "off"
const triTo = (v: string | null) =>
  v === "on" ? true : v === "off" ? false : null
const SEND_COMMUNITY = [
  { value: "none", label: "None" },
  { value: "standard", label: "Standard" },
  { value: "extended", label: "Extended" },
  { value: "both", label: "Standard and extended" },
  { value: "large", label: "Large" },
]

export type NeighborParent = { kind: "session" | "peer_group"; id: string }

function NeighborAFForm({
  parent,
  item,
  taken,
  onSaved,
  onCancel,
}: {
  parent: NeighborParent
  item: BGPNeighborAF | null
  taken: AfiSafi[]
  onSaved: () => void
  onCancel: () => void
}) {
  const [afi, setAfi] = useState<string | null>(
    item?.afi_safi ??
      AFI_SAFI.find((a) => !taken.includes(a.id))?.id ??
      "ipv4-unicast"
  )
  const [activate, setActivate] = useState(item?.activate ?? true)
  const [importId, setImportId] = useState(item?.import_policy?.id ?? null)
  const [exportId, setExportId] = useState(item?.export_policy?.id ?? null)
  const [plIn, setPlIn] = useState(item?.prefix_list_in?.id ?? null)
  const [plOut, setPlOut] = useState(item?.prefix_list_out?.id ?? null)
  const [defOrig, setDefOrig] = useState(triFrom(item?.default_originate))
  const [defOrigPolicy, setDefOrigPolicy] = useState(
    item?.default_originate_policy?.id ?? null
  )
  const [nhs, setNhs] = useState(triFrom(item?.next_hop_self))
  const [rrc, setRrc] = useState(triFrom(item?.route_reflector_client))
  const [soft, setSoft] = useState(triFrom(item?.soft_reconfiguration))
  const [asOverride, setAsOverride] = useState(triFrom(item?.as_override))
  const [rpa, setRpa] = useState(triFrom(item?.remove_private_as))
  const [sendCommunity, setSendCommunity] = useState<string | null>(
    item?.send_community || null
  )
  const [allowas, setAllowas] = useState(numText(item?.allowas_in))
  const [maxPrefix, setMaxPrefix] = useState(numText(item?.maximum_prefix))

  const policies = usePickList<{ id: string; name: string }>(
    "routing-policies",
    "/api/routing/policies/",
    (p) => p.name
  ).map((p) => ({ value: p.id, label: p.label }))
  const prefixLists = usePickList<{ id: string; name: string }>(
    "prefix-lists",
    "/api/routing/prefix-lists/",
    (p) => p.name
  ).map((p) => ({ value: p.id, label: p.label }))

  const { mutation, fieldErrors } = useRoutingSave<BGPNeighborAF>({
    objectType: ROUTING_OBJECT_TYPES.bgpneighboraf,
    endpoint: "/api/routing/bgp-neighbor-afs/",
    queryKey: "bgp-neighbor-afs",
    id: item?.id,
    label: (v) => v.afi_safi,
    onSaved,
  })
  const inherit = "Inherit"

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate({
          ...(item
            ? {}
            : parent.kind === "session"
              ? { session_id: parent.id }
              : { peer_group_id: parent.id }),
          afi_safi: afi,
          activate,
          import_policy_id: importId,
          export_policy_id: exportId,
          prefix_list_in_id: plIn,
          prefix_list_out_id: plOut,
          default_originate: triTo(defOrig),
          default_originate_policy_id: defOrig === "off" ? null : defOrigPolicy,
          next_hop_self: triTo(nhs),
          route_reflector_client: triTo(rrc),
          soft_reconfiguration: triTo(soft),
          as_override: triTo(asOverride),
          remove_private_as: triTo(rpa),
          send_community: sendCommunity ?? "",
          allowas_in: numOrNull(allowas),
          maximum_prefix: numOrNull(maxPrefix),
        })
      }}
      className="@container grid gap-4"
    >
      <FormSection title="Family">
        <div className="grid gap-3 @md:grid-cols-2">
          <FormSelect
            label="Address family"
            value={afi}
            onChange={setAfi}
            options={AFI_SAFI.filter(
              (a) => a.id === item?.afi_safi || !taken.includes(a.id)
            ).map((a) => ({ value: a.id, label: a.label }))}
            error={fieldErrors.afi_safi}
          />
          <div className="flex items-end pb-2">
            <FormCheckbox
              label="Activate"
              checked={activate}
              onChange={setActivate}
              info="Off prints no neighbor … activate, for a family the platform turns on by default."
            />
          </div>
        </div>
      </FormSection>
      <FormSection title="Policy">
        <div className="grid gap-3 @md:grid-cols-2">
          <FormCombobox
            label="Import policy"
            value={importId}
            onChange={setImportId}
            options={policies}
            noneLabel={inherit}
            placeholder={inherit}
            error={fieldErrors.import_policy_id}
          />
          <FormCombobox
            label="Export policy"
            value={exportId}
            onChange={setExportId}
            options={policies}
            noneLabel={inherit}
            placeholder={inherit}
            error={fieldErrors.export_policy_id}
          />
          <FormCombobox
            label="Prefix list in"
            value={plIn}
            onChange={setPlIn}
            options={prefixLists}
            noneLabel={inherit}
            placeholder={inherit}
            error={fieldErrors.prefix_list_in_id}
          />
          <FormCombobox
            label="Prefix list out"
            value={plOut}
            onChange={setPlOut}
            options={prefixLists}
            noneLabel={inherit}
            placeholder={inherit}
            error={fieldErrors.prefix_list_out_id}
          />
          <FormSelect
            label="Default originate"
            value={defOrig}
            onChange={setDefOrig}
            options={TRI}
            noneLabel={inherit}
          />
          {defOrig === "on" && (
            <FormCombobox
              label="Default originate policy"
              value={defOrigPolicy}
              onChange={setDefOrigPolicy}
              options={policies}
              noneLabel={inherit}
              placeholder={inherit}
              error={fieldErrors.default_originate_policy_id}
            />
          )}
        </div>
      </FormSection>
      <FormSection title="Knobs">
        <div className="grid gap-3 @md:grid-cols-3">
          <FormSelect
            label="Next-hop self"
            value={nhs}
            onChange={setNhs}
            options={TRI}
            noneLabel={inherit}
          />
          <FormSelect
            label="Route reflector client"
            value={rrc}
            onChange={setRrc}
            options={TRI}
            noneLabel={inherit}
          />
          <FormSelect
            label="Soft reconfiguration"
            value={soft}
            onChange={setSoft}
            options={TRI}
            noneLabel={inherit}
          />
          <FormSelect
            label="AS override"
            value={asOverride}
            onChange={setAsOverride}
            options={TRI}
            noneLabel={inherit}
          />
          <FormSelect
            label="Remove private AS"
            value={rpa}
            onChange={setRpa}
            options={TRI}
            noneLabel={inherit}
          />
          <FormSelect
            label="Send community"
            value={sendCommunity}
            onChange={setSendCommunity}
            options={SEND_COMMUNITY}
            noneLabel={inherit}
          />
          <FormText
            label="Allowas-in"
            type="number"
            value={allowas}
            onChange={setAllowas}
            error={fieldErrors.allowas_in}
          />
          <FormText
            label="Maximum prefix"
            type="number"
            value={maxPrefix}
            onChange={setMaxPrefix}
            error={fieldErrors.maximum_prefix}
          />
        </div>
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={item ? "Save changes" : "Add family"}
      />
    </form>
  )
}

/** The address-family rows of a session or a peer group, edited through a
 * dialog. `rows` come nested on the parent (`afs`); `invalidate` is the
 * parent's detail query. */
export function NeighborAFTable({
  parent,
  rows,
  invalidate,
  canEdit: canEditParent = true,
}: {
  parent: NeighborParent
  rows: BGPNeighborAF[]
  invalidate: readonly unknown[]
  canEdit?: boolean
}) {
  const { canDo } = useMe()
  const qc = useQueryClient()
  const [editing, setEditing] = useState<BGPNeighborAF | null>(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<BGPNeighborAF | null>(null)
  const canEdit = canEditParent && canDo("bgpneighboraf", "change")
  const canAdd = canEditParent && canDo("bgpneighboraf", "add")
  const canDelete = canEditParent && canDo("bgpneighboraf", "delete")
  const columns = useMemo(
    () =>
      buildNeighborAFColumns({
        actions: {
          onEdit: setEditing,
          canEdit: () => canEdit,
          onDelete: setDeleting,
          canDelete: () => canDelete,
        },
      }),
    [canEdit, canDelete]
  )
  const refresh = () => {
    qc.invalidateQueries({ queryKey: invalidate })
    qc.invalidateQueries({ queryKey: ["bgp-sessions"] })
  }
  const close = () => {
    setAdding(false)
    setEditing(null)
  }
  const taken = rows.map((r) => r.afi_safi)

  return (
    <div className="grid gap-3">
      {canAdd && taken.length < AFI_SAFI.length && (
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Add family
          </Button>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No address families yet.
        </p>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          tableId={`neighbor-afs-${parent.kind}`}
          enableExport={false}
        />
      )}
      <Dialog open={adding || !!editing} onOpenChange={(o) => !o && close()}>
        <DialogContent size="2xl" className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing ? `Edit ${editing.afi_safi}` : "Add address family"}
            </DialogTitle>
          </DialogHeader>
          {(adding || editing) && (
            <NeighborAFForm
              parent={parent}
              item={editing}
              taken={taken}
              onSaved={() => {
                refresh()
                close()
              }}
              onCancel={close}
            />
          )}
        </DialogContent>
      </Dialog>
      <RoutingDeleteDialog
        item={deleting}
        endpoint="/api/routing/bgp-neighbor-afs/"
        queryKey="bgp-neighbor-afs"
        label={(r) => r.afi_safi}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={refresh}
      />
    </div>
  )
}

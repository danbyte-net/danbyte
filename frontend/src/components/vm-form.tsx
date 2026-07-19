import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useSiteOptions } from "@/lib/use-site-options"
import { toast } from "sonner"

import {
  api,
  type DeviceRoleOption,
  type Paginated,
  type PlatformOption,
  type Status,
  type VirtualMachine,
  type VirtualMachineWritePayload,
} from "@/lib/api"
import {
  FormCombobox,
  QuickAddDialog,
  UnitInput,
  MEMORY_UNITS,
  DISK_UNITS,
  FormFooter,
  FormRow,
  FormTags,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { DevicePicker } from "@/components/device-picker"
import { IpPicker } from "@/components/ip-picker"
import { CustomFieldInputs } from "@/components/custom-field-inputs"

interface MiniNamed {
  id: string
  name: string
}

/** Parse a numeric text input → number | null (blank/invalid → null). */
function numOrNull(s: string): number | null {
  const t = s.trim()
  if (t === "") return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

export interface VmFormProps {
  vm?: VirtualMachine
  onSaved: (saved: VirtualMachine) => void
  onCancel: () => void
}

export function VmForm({ vm, onSaved, onCancel }: VmFormProps) {
  const isEdit = !!vm
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(vm?.name ?? "")
  const [clusterId, setClusterId] = useState<string | null>(
    vm?.cluster.id ?? null
  )
  const [deviceId, setDeviceId] = useState<string | null>(
    vm?.device?.id ?? null
  )
  const [siteId, setSiteId] = useState<string | null>(vm?.site?.id ?? null)
  const [roleId, setRoleId] = useState<string | null>(vm?.role?.id ?? null)
  const [platformId, setPlatformId] = useState<string | null>(
    vm?.platform?.id ?? null
  )
  const [primaryIpId, setPrimaryIpId] = useState<string | null>(
    vm?.primary_ip?.id ?? null
  )
  const [statusId, setStatusId] = useState<string | null>(
    vm?.status?.id ?? null
  )
  const [vcpus, setVcpus] = useState(vm?.vcpus != null ? String(vm.vcpus) : "")
  const [memoryMb, setMemoryMb] = useState(
    vm?.memory_mb != null ? String(vm.memory_mb) : ""
  )
  const [diskGb, setDiskGb] = useState(
    vm?.disk_gb != null ? String(vm.disk_gb) : ""
  )
  const [description, setDescription] = useState(vm?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    vm?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    vm?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!vm) return
    setName(vm.name)
    setClusterId(vm.cluster.id)
    setDeviceId(vm.device?.id ?? null)
    setSiteId(vm.site?.id ?? null)
    setRoleId(vm.role?.id ?? null)
    setPlatformId(vm.platform?.id ?? null)
    setPrimaryIpId(vm.primary_ip?.id ?? null)
    setStatusId(vm.status?.id ?? null)
    setVcpus(vm.vcpus != null ? String(vm.vcpus) : "")
    setMemoryMb(vm.memory_mb != null ? String(vm.memory_mb) : "")
    setDiskGb(vm.disk_gb != null ? String(vm.disk_gb) : "")
    setDescription(vm.description)
    setTagIds(vm.tags.map((t) => t.id))
    setCustomFields(vm.custom_fields ?? {})
    reset()
  }, [vm, reset])

  const clusters = useQuery({
    queryKey: ["clusters-picker"],
    queryFn: () => api<Paginated<MiniNamed>>("/api/clusters/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const sites = useSiteOptions()
  const roles = useQuery({
    queryKey: ["device-roles-picker"],
    queryFn: () =>
      api<Paginated<DeviceRoleOption>>("/api/device-roles/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const platforms = useQuery({
    queryKey: ["platforms-picker"],
    queryFn: () => api<Paginated<PlatformOption>>("/api/platforms/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const statuses = useQuery({
    queryKey: ["statuses", "virtualmachine"],
    queryFn: () =>
      api<Paginated<Status>>(
        "/api/statuses/?available_to=virtualmachine&picker=1"
      ),
    staleTime: 5 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: VirtualMachineWritePayload = {
        name: name.trim(),
        cluster_id: clusterId ?? "",
        device_id: deviceId,
        site_id: siteId,
        role_id: roleId,
        platform_id: platformId,
        primary_ip_id: primaryIpId,
        status_id: statusId,
        vcpus: numOrNull(vcpus),
        memory_mb: numOrNull(memoryMb),
        disk_gb: numOrNull(diskGb),
        description: description.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      if (isEdit)
        return api<VirtualMachine>(`/api/virtual-machines/${vm!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<VirtualMachine>("/api/virtual-machines/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["virtual-machines"] })
      qc.invalidateQueries({ queryKey: ["virtual-machines-picker"] })
      qc.invalidateQueries({ queryKey: ["virtual-machine", saved.id] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
      onSaved(saved)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  return (
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
        placeholder="web-01"
        error={fieldErrors.name}
      />

      <FormCombobox
        label="Cluster"
        value={clusterId}
        onChange={setClusterId}
        options={(clusters.data?.results ?? []).map((c) => ({
          value: c.id,
          label: c.name,
        }))}
        placeholder="Select a cluster…"
        searchPlaceholder="Search clusters…"
        emptyText="No clusters."
        error={fieldErrors.cluster_id}
        quickAdd={
          <QuickAddDialog
            title="New cluster"
            endpoint="/api/clusters/"
            fields={[
              { name: "name", label: "Name", required: true },
              {
                name: "type_id",
                label: "Type",
                type: "combobox",
                endpoint: "/api/cluster-types/?picker=1",
                queryKey: "cluster-types-picker",
                required: true,
                quickAdd: {
                  title: "New cluster type",
                  endpoint: "/api/cluster-types/",
                  fields: [
                    { name: "name", label: "Name", required: true },
                    {
                      name: "description",
                      label: "Description",
                      type: "textarea",
                    },
                  ],
                },
              },
            ]}
            onCreated={(c) => {
              qc.invalidateQueries({ queryKey: ["clusters-picker"] })
              setClusterId(c.id)
            }}
          />
        }
      />

      <DevicePicker
        label="Host device"
        hint="optional"
        value={deviceId}
        onChange={setDeviceId}
        noneLabel="No host device"
        placeholder="Select a host device…"
        error={fieldErrors.device_id}
      />

      <FormCombobox
        label="Site"
        hint="optional"
        value={siteId}
        onChange={setSiteId}
        options={sites.options.map((s) => ({
          value: s.id,
          label: s.name,
        }))}
        noneLabel="No site"
        placeholder="Select a site…"
        searchPlaceholder="Search sites…"
        emptyText="No sites."
        error={fieldErrors.site_id}
      />

      <FormCombobox
        label="Role"
        hint="optional"
        value={roleId}
        onChange={setRoleId}
        options={(roles.data?.results ?? []).map((r) => ({
          value: r.id,
          label: r.name,
        }))}
        noneLabel="No role"
        placeholder="Select a role…"
        searchPlaceholder="Search roles…"
        emptyText="No device roles."
        error={fieldErrors.role_id}
        quickAdd={
          <QuickAddDialog
            title="New device role"
            endpoint="/api/device-roles/"
            fields={[
              { name: "name", label: "Name", required: true },
              { name: "description", label: "Description", type: "textarea" },
            ]}
            onCreated={(r) => {
              qc.invalidateQueries({ queryKey: ["device-roles-picker"] })
              setRoleId(r.id)
            }}
          />
        }
      />

      <FormCombobox
        label="Platform"
        hint="optional"
        value={platformId}
        onChange={setPlatformId}
        options={(platforms.data?.results ?? []).map((p) => ({
          value: p.id,
          label: p.name,
        }))}
        noneLabel="No platform"
        placeholder="Select a platform…"
        searchPlaceholder="Search platforms…"
        emptyText="No platforms."
        error={fieldErrors.platform_id}
        quickAdd={
          <QuickAddDialog
            title="New platform"
            endpoint="/api/platforms/"
            fields={[{ name: "name", label: "Name", required: true }]}
            onCreated={(p) => {
              qc.invalidateQueries({ queryKey: ["platforms-picker"] })
              setPlatformId(p.id)
            }}
          />
        }
      />

      <FormCombobox
        label="Status"
        value={statusId}
        onChange={setStatusId}
        options={(statuses.data?.results ?? []).map((s) => ({
          value: s.id,
          label: s.name,
        }))}
        noneLabel="No status"
        placeholder="Select a status…"
        error={fieldErrors.status_id}
      />

      <FormRow cols={3}>
        <FormText
          label="vCPUs"
          type="number"
          inputMode="numeric"
          min={0}
          value={vcpus}
          onChange={setVcpus}
          placeholder="—"
          error={fieldErrors.vcpus}
        />
        <UnitInput
          label="Memory"
          base="MB"
          units={MEMORY_UNITS}
          value={memoryMb}
          onChange={setMemoryMb}
          error={fieldErrors.memory_mb}
        />
        <UnitInput
          label="Disk"
          base="GB"
          units={DISK_UNITS}
          value={diskGb}
          onChange={setDiskGb}
          error={fieldErrors.disk_gb}
        />
      </FormRow>

      <IpPicker
        label="Primary IP"
        hint="optional"
        value={primaryIpId}
        onChange={setPrimaryIpId}
        noneLabel="No primary IP"
        placeholder="Select an IP…"
        error={fieldErrors.primary_ip_id}
      />

      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        error={fieldErrors.description}
      />

      <FormTags
        label="Tags"
        value={tagIds}
        onChange={setTagIds}
        error={fieldErrors.tag_ids}
      />

      <CustomFieldInputs
        model="virtualmachine"
        value={customFields}
        onChange={setCustomFields}
      />

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create virtual machine"}
      />
    </form>
  )
}

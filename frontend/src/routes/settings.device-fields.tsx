import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type DeviceFieldVisibility } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { FormCheckbox } from "@/components/forms"
import {
  SettingsCard,
  SettingsGrid,
  SettingsHeader,
} from "@/components/settings/settings-card"

export const Route = createFileRoute("/settings/device-fields")({
  component: DeviceFieldsPage,
})

const DEVICE_FIELDS: {
  key: keyof DeviceFieldVisibility
  label: string
  hint: string
}[] = [
  { key: "comments", label: "Comments", hint: "Long-form notes on a device" },
  {
    key: "location",
    label: "Location",
    hint: "Link a device to a sub-site Location",
  },
  {
    key: "cluster",
    label: "Cluster",
    hint: "Link a device to its virtualization cluster",
  },
  { key: "airflow", label: "Airflow", hint: "Chassis airflow direction" },
  { key: "latitude", label: "Latitude", hint: "GPS coordinates (for maps)" },
  { key: "longitude", label: "Longitude", hint: "GPS coordinates (for maps)" },
]

function DeviceFieldsPage() {
  const { canManageDeployment, isLoading } = useMe()
  if (isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (!canManageDeployment) {
    return (
      <p className="text-sm text-muted-foreground">
        You need the <span className="font-mono">users.manage</span> permission
        to manage deployment settings.
      </p>
    )
  }
  return (
    <div className="space-y-6">
      <SettingsHeader title="Device fields">
        Which optional built-in fields appear on the device form and detail
        page.
      </SettingsHeader>
      <SettingsGrid>
        <DeviceFieldsCard />
      </SettingsGrid>
    </div>
  )
}

function DeviceFieldsCard() {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ["device-field-visibility"],
    queryFn: () => api<DeviceFieldVisibility>("/api/deployment/device-fields/"),
  })
  const [fields, setFields] = useState<DeviceFieldVisibility | null>(null)
  useEffect(() => {
    if (data) setFields(data)
  }, [data])

  const save = useMutation({
    mutationFn: () =>
      api<DeviceFieldVisibility>("/api/deployment/device-fields/", {
        method: "PUT",
        body: JSON.stringify(fields),
      }),
    onSuccess: (d) => {
      qc.setQueryData(["device-field-visibility"], d)
      qc.invalidateQueries({ queryKey: ["device-field-visibility"] })
      toast.success("Saved device fields")
    },
    onError: (e) => apiErrorToast(e),
  })

  if (!fields) return null
  return (
    <SettingsCard
      title="Device fields"
      description="Choose which optional built-in fields appear on the device form and detail page. Hidden fields are simply omitted — existing values are kept and shown again if you re-enable the field."
      onSave={() => save.mutate()}
      dirty={JSON.stringify(fields) !== JSON.stringify(data)}
      saving={save.isPending}
      saveLabel="Save device fields"
    >
      {DEVICE_FIELDS.map((f) => (
        <FormCheckbox
          key={f.key}
          label={f.label}
          checked={fields[f.key]}
          onChange={(v) => setFields({ ...fields, [f.key]: v })}
          hint={f.hint}
        />
      ))}
    </SettingsCard>
  )
}

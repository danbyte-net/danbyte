import { ObjectPicker } from "@/components/object-picker"
import type {
  ObjectPickerProps,
  ObjectPickerSpec,
} from "@/components/object-picker"
import { PEOPLE_ENDPOINT } from "@/lib/people"
import type { Person } from "@/lib/people"

// A member of the active tenant, for pickers outside user administration
// (a vulnerability exception's owner). Reads /api/people/, which lists the
// tenant's active accounts for anyone who works with such a feature.
// People are keyed by their numeric user id; the picker hands it back as
// the option value.

type Row = Omit<Person, "id"> & { id: string }

const label = (p: Row) =>
  p.display_name && p.display_name !== p.username
    ? `${p.display_name} (${p.username})`
    : p.username

export const PERSON_PICKER_SPEC: ObjectPickerSpec<Row, Row> = {
  noun: "person",
  pickerEndpoint: PEOPLE_ENDPOINT,
  pickerQueryKey: ["people-picker"],
  optionLabel: label,
  detailEndpoint: (id) => `${PEOPLE_ENDPOINT}${id}/`,
  detailQueryKey: (id) => ["people", id],
  detailLabel: label,
  listEndpoint: PEOPLE_ENDPOINT,
  searchHint: "Search people…",
  filters: [],
  columns: [
    { header: "Name", cell: (p) => p.display_name || p.username },
    {
      header: "Username",
      cell: (p) => <span className="font-mono text-xs">{p.username}</span>,
    },
  ],
}

export function PersonPicker(props: ObjectPickerProps) {
  return (
    <ObjectPicker<Row, Row>
      spec={PERSON_PICKER_SPEC}
      placeholder="Pick a person"
      emptyText="No people."
      {...props}
    />
  )
}

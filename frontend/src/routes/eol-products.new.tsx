import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EolProductForm } from "@/components/eol-product-form"
import { EditPageShell } from "@/components/edit-page-shell"

export const Route = createFileRoute("/eol-products/new")({
  component: NewEolProductPage,
})

function NewEolProductPage() {
  const nav = useNavigate()
  return (
    <EditPageShell
      crumbs={[
        { label: "End-of-life products", to: "/eol-products" },
        { label: "Add" },
      ]}
      title="Add end-of-life product"
    >
      <EolProductForm
        onSaved={(p) => nav({ to: "/eol-products/$id", params: { id: p.id } })}
        onCancel={() => nav({ to: "/eol-products" })}
      />
    </EditPageShell>
  )
}

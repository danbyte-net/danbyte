import { createFileRoute, Outlet } from "@tanstack/react-router"
export const Route = createFileRoute("/export-templates")({
  component: () => <Outlet />,
})

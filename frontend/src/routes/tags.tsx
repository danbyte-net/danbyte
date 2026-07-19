import { createFileRoute, Outlet } from "@tanstack/react-router"

// Layout-only route for the /tags branch. List lives in tags.index.tsx;
// detail in tags.$id.tsx.
export const Route = createFileRoute("/tags")({
  component: () => <Outlet />,
})

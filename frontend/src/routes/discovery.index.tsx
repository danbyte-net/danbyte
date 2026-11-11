import { createFileRoute, redirect } from "@tanstack/react-router"

// Discovery's home is the Monitoring page's Discovery tab (#451). /discovery
// still answers - bookmarks and links into it keep working - by opening
// that tab; the profile, run, findings and open-ports pages stay where they
// were.

export const Route = createFileRoute("/discovery/")({
  beforeLoad: () => {
    throw redirect({
      to: "/monitoring",
      search: { view: "discovery", status: "all" },
      replace: true,
    })
  },
})

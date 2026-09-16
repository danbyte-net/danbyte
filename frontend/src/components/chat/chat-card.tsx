import { Link } from "@tanstack/react-router"
import { ExternalLink, MapPin } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { ColorBadge } from "@/components/cells/color-badge"

export interface ChatCardFact {
  label: string
  value: string
  url?: string | null
}

export interface ChatCardData {
  type: string
  id: string
  title: string
  url?: string | null
  description?: string
  status?: { name: string; color: string } | null
  image?: string | null
  latitude?: number | null
  longitude?: number | null
  facts: ChatCardFact[]
  created?: boolean
  updated?: boolean
}

const TYPE_LABEL: Record<string, string> = {
  device: "Device",
  virtualmachine: "Virtual machine",
  site: "Site",
  rack: "Rack",
  prefix: "Prefix",
  ipaddress: "IP address",
  cluster: "Cluster",
  circuit: "Circuit",
  vlan: "VLAN",
  devicetype: "Device type",
}

/** The object an answer is about, rendered rather than described: a picture
 * of the model where there is one, where it sits, and a way through to it. */
export function ChatCard({ card }: { card: ChatCardData }) {
  const placed = card.latitude != null && card.longitude != null
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-start gap-3 p-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">
              {TYPE_LABEL[card.type] ?? card.type}
            </Badge>
            {card.created && <Badge variant="success">created</Badge>}
            {card.updated && !card.created && (
              <Badge variant="warning">updated</Badge>
            )}
            {card.status && (
              <ColorBadge name={card.status.name} color={card.status.color} />
            )}
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            {card.url ? (
              <Link to={card.url} className="link text-[13px] font-medium">
                {card.title}
              </Link>
            ) : (
              <span className="text-[13px] font-medium">{card.title}</span>
            )}
            {card.url && (
              <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
          </div>
          {card.description && (
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              {card.description}
            </p>
          )}
        </div>
        {card.image && (
          <img
            src={card.image}
            alt=""
            className="h-12 w-28 shrink-0 rounded border border-border object-contain"
          />
        )}
      </div>

      {card.facts.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t border-border px-3 py-2 text-[12px]">
          {card.facts.map((fact) => (
            <FactRow key={fact.label} fact={fact} />
          ))}
        </dl>
      )}

      {placed && (
        <a
          href={`https://www.openstreetmap.org/?mlat=${card.latitude}&mlon=${card.longitude}#map=13/${card.latitude}/${card.longitude}`}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 border-t border-border px-3 py-2 text-[11px] text-muted-foreground hover:bg-muted/50"
        >
          <MapPin className="h-3 w-3" />
          {card.latitude?.toFixed(4)}, {card.longitude?.toFixed(4)}
          <span className="ml-auto">Open map</span>
        </a>
      )}
    </div>
  )
}

function FactRow({ fact }: { fact: ChatCardFact }) {
  return (
    <>
      <dt className="text-muted-foreground">{fact.label}</dt>
      <dd className="min-w-0 truncate">
        {fact.url ? (
          <Link to={fact.url} className="link">
            {fact.value}
          </Link>
        ) : (
          fact.value
        )}
      </dd>
    </>
  )
}

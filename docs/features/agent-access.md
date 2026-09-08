---
icon: lucide/bot
---

# Agent access (MCP)

Danbyte can answer questions from an AI assistant: "which hosts in this
prefix are down, and where are they physically?", "what changed on this
device in the last 48 hours?", "which hardware goes end of support next
year?". The assistant reaches Danbyte directly, so the correlations that
make the data useful - health, location, lifecycle, history - stay
together instead of being copy-pasted apart.

It speaks the **Model Context Protocol**, which Claude Desktop, Claude
Code, Cursor and VS Code all support, and it runs entirely on your box.
No cloud service, no model shipped by us, nothing sent anywhere.

**It is off until you turn it on**, like the other integrations.

## Turning it on

**Settings → Integrations** has two switches:

| Switch | What it does |
|---|---|
| **Agent access (MCP)** | Opens `/api/mcp/` for this tenant. Reading only. |
| **Agent access: allow writes** | Also lets an assistant create, edit and delete. |

With the first switch off, the endpoint answers "Integration not enabled"
and the **Agent access** page is hidden. Both are per tenant, and both
need a tenant admin.

Turning the first one on adds **Integrations → Agent access**, where you
connect a client, set limits and read the call log.

## Connecting a client

Make an API token first, under **Settings → Preferences → API tokens**. A
**read-only** token is the right default: it cannot write even if writes
are on and the assistant is asked to.

The Agent access page prints the exact snippet for each client with this
deployment's own URL. In short:

=== "Claude Code"

    ```bash
    claude mcp add --transport http danbyte https://danbyte.example.com/api/mcp/ \
      --header "Authorization: Token <your-token>"
    ```

=== "Claude Desktop"

    Claude Desktop speaks stdio, so it reaches an HTTP server through the
    `mcp-remote` shim. In `claude_desktop_config.json`:

    ```json
    {
      "mcpServers": {
        "danbyte": {
          "command": "npx",
          "args": ["-y", "mcp-remote", "https://danbyte.example.com/api/mcp/",
                   "--header", "Authorization: Token <your-token>"]
        }
      }
    }
    ```

=== "Cursor"

    In `.cursor/mcp.json`:

    ```json
    {
      "mcpServers": {
        "danbyte": {
          "url": "https://danbyte.example.com/api/mcp/",
          "headers": { "Authorization": "Token <your-token>" }
        }
      }
    }
    ```

=== "VS Code"

    In `.vscode/mcp.json`, with the token prompted for rather than stored:

    ```json
    {
      "servers": {
        "danbyte": {
          "type": "http",
          "url": "https://danbyte.example.com/api/mcp/",
          "headers": { "Authorization": "Token ${input:danbyte_token}" }
        }
      },
      "inputs": [{ "id": "danbyte_token", "type": "promptString",
                   "description": "Danbyte API token", "password": true }]
    }
    ```

Keep the token out of anything you commit. Revoking it cuts the assistant
off at once.

## What an assistant can do

| Tool | Answers |
|---|---|
| `types` | What this token can read, with counts. Where an assistant starts. |
| `search` | The same ranked search as the palette, including narrowing tokens such as `type:device site:aarhus`. |
| `get` | One object in full, by id or exact name. |
| `list` | Rows of one type with the usual filters, paged. |
| `explain` | A type's fields and what this token may do with it. |
| `where_is` | Site, location, rack and unit, cluster and host, primary address. |
| `monitoring_status` | Check state, last seen and open alerts. |
| `changes` | Change-log entries for one object: who, what, when. |
| `lifecycle` | Device types past or approaching end of sale or support. |

With writes on, three more: `create`, `update` and `delete`. A delete has
to name the object it removes, so a mistaken instruction cannot take the
wrong row.

## What keeps it safe

- **It is the token's access, not a new one.** Every call goes through the
  same API, serializers, permissions and site scoping as the browser. A
  site-scoped account's assistant sees one site. An object the token
  cannot see reads as "not found", never "forbidden", so the endpoint
  never confirms that something exists.
- **Tokens only.** Session cookies are refused, so there is no way to ride
  a logged-in browser session.
- **Read-only means read-only.** A read-scope token is refused before any
  tool runs.
- **Secrets never leave.** Credentials are write-only in the API already;
  on top of that, anything the secret classifier recognises is stripped
  from every answer.
- **Answers are capped** at the row limit you set, and an assistant is
  always told when a result was cut short, so it does not conclude it saw
  everything.
- **Everything is logged.** Recent calls shows the tool, the object type,
  the account and token, the row count and any error. That is how you
  answer "what has it actually read".
- **Rate limited** to 120 calls a minute per token.
- Writes land in the **change log** under the token's account, with the
  same before-and-after detail as any other change.

An honest note: an assistant with a broad token can read broadly, exactly
as the person could. The narrowing that matters is the token's own
permissions - give an assistant a purpose-made account rather than your
own.

## Limits

On the Agent access page:

- **Rows per answer** - the cap for every list and search. Default 50.
- **Object types** - restrict agents to a subset (say devices, IPs and
  prefixes). Empty means every type the token already allows.

## Troubleshooting

| What you see | Why |
|---|---|
| The client cannot connect, "not enabled" | The first switch is off for this tenant. |
| "This Danbyte allows agents to read only" | Writes are off. |
| "This API token is read-only" | The token's scope is read; make a full-scope one, or leave it and read only. |
| Empty results everywhere | The token's account has no permissions for that type. |
| "More than 120 calls a minute" | The rate limit; it clears within a minute. |

Calls and their errors are on the Agent access page, which is the first
place to look.

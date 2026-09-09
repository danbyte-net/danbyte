---
icon: lucide/messages-square
---

# Ask Danbyte (in-app chat)

A chat panel in the top bar, next to the docs button, that answers
questions about your own network: "which devices are at Aarhus and are any
of them down?", "what changed on this switch yesterday?", "what goes end of
support next year?".

It reads through the same tools the [agent access](agent-access.md)
endpoint uses, as **you**, so it sees exactly what you see on the pages -
no more. Every lookup it makes is shown in the answer, so you can check it
rather than take it on trust.

**It is off until you turn it on**, and it needs a model connection.

## What leaves your network

This is the honest part, and the reason for the local option.

Unlike agent access, where your own editor talks to a model you chose,
**Danbyte itself calls the model here**. Your question, the conversation so
far, and whatever the tools read on your behalf are sent to the provider a
deployment admin configured. With Anthropic or an OpenAI-compatible
service, that means your inventory data goes to that company.

Choose the **local** provider - Ollama or LM Studio on your own network -
and nothing leaves the building. That option exists precisely so an
airgapped install can use the feature.

## Turning it on

Two steps, deliberately at different levels.

**1. Connect a model** (deployment admin, Settings → Security → Assistant
model):

| Provider | For |
|---|---|
| **Anthropic** | Claude, through the Messages API. Needs an API key. |
| **OpenAI-compatible** | OpenAI, Azure OpenAI, Groq, OpenRouter and most gateways. Needs a key and, for a gateway, its endpoint. |
| **Local model** | Ollama or LM Studio on your own network. No key. Endpoint like `http://127.0.0.1:11434`. |

**Test connection** asks the model for one word, so a wrong key or a
stopped Ollama is obvious here rather than in the chat.

The key is stored encrypted and never returned by the API. Only a
deployment admin can set any of this: it decides where your data goes, so
a tenant admin must not be able to change it.

**2. Turn the chat on** (tenant admin, Settings → Integrations →
**Assistant chat**). The top-bar button appears for everyone in that
tenant.

## Using it

Open it from the top bar or press ⌘J (Ctrl+J). Type a question, Enter to
send, Shift+Enter for a new line.

- **Lookups are shown.** Each answer lists what it read - `list · 12 rows` -
  and expanding one shows exactly what was asked.
- **New conversation** starts a fresh thread. **Past conversations** lists
  the ones you have had.
- Conversations are **private to you**. Nobody else sees them, not other
  members and not an administrator. Delete one from the list, or all of
  them at once.

## What it can and cannot do

- It runs with **your** permissions. A site-scoped account's chat only sees
  that site.
- Results are **capped** at the row limit on the Agent access page, and it
  is told when a result was cut short.
- It **cannot change anything** unless *Agent access: allow writes* is on.
  With writes off it says so plainly. With writes on, a change follows your
  own permissions and lands in the change log with **Via: Assistant** and
  your own name in the User column.
- Every lookup is recorded on **Integrations → Agent access → Recent
  calls**, with the client shown as `chat`.
- It stops after several rounds of looking things up, so a confused model
  cannot loop.

## Troubleshooting

| What you see | Why |
|---|---|
| No button in the top bar | The chat is off for this tenant. |
| "No model is configured" | Nobody has connected a model under Settings → Security. |
| "The model provider refused the API key" | Wrong or expired key. |
| "Could not reach …" | The endpoint is wrong, or a local model server is not running. |
| "… is not a public address" | A public provider was pointed at an internal host. Use the local provider for a model on your own network. |
| "Not connected" under the composer | The WebSocket did not open. Check that the `danbyte-ws` service is running and that your reverse proxy passes `/ws/`. |

The chat streams over the WebSocket service rather than the API, because a
long answer would outlast an ordinary HTTP request. A deployment that
proxies `/api/` but not `/ws/` gets the whole product except this panel.

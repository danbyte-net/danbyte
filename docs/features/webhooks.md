---
icon: lucide/webhook
---

# Webhooks

Webhooks let Danbyte notify an external system whenever your data changes. When an
object you care about is created, updated, or deleted, Danbyte sends an HTTP
request carrying the details to a URL you choose — so you can trigger automation,
sync to another tool, or feed an event pipeline.

Webhooks live under **Integrations → Webhooks** in the sidebar.

## Create a webhook

1. Go to **Integrations → Webhooks** and click **Add webhook**.
2. Fill in the form:

   | Field | What it does |
   |---|---|
   | **Name** | A label for the webhook. |
   | **Enabled** | Turn delivery on or off without deleting the webhook. |
   | **Object types** | Which object types fire this webhook. Choose specific types or **All object types**. |
   | **Triggers** | Which events fire it — **Create**, **Update**, **Delete** (any combination). |
   | **Method** | The HTTP method to send: `POST`, `PUT`, or `PATCH`. |
   | **Payload URL** | The endpoint Danbyte sends the request to. |
   | **Content type** | The content type of the request body. |
   | **Secret** | Optional signing key (see below). Write-only — once saved, the value is never shown again. |
   | **Additional headers** | Extra headers, one `Name: value` per line. |
   | **Verify TLS** | Whether to verify the server's TLS certificate. |

3. Save.

## What gets delivered

When a matching change happens, Danbyte sends the request with a JSON body that
identifies the event and the object that changed, including the object's data.
Every delivery also carries:

| Header | Meaning |
|---|---|
| `X-Danbyte-Event` | The event that fired (`create` / `update` / `delete`). |
| `X-Danbyte-Delivery` | A unique ID for this individual delivery. |
| `X-Danbyte-Signature` | The signature, when a secret is set (see below). |

!!! note "Deliveries are best-effort and off the request path"
    Webhooks are sent in the background, so saving an object is never slowed down
    or blocked by a webhook. If the destination is unreachable, the delivery
    simply fails and is logged — it can never break the change that triggered it.

## Verify the payload with a secret

If you set a **secret**, Danbyte signs each request body and sends the signature
in the `X-Danbyte-Signature` header in the form `sha512=<hex>`. The receiving
service can recompute an HMAC-SHA512 of the raw body using the same secret and
compare — if they match, the request genuinely came from your Danbyte instance
and wasn't tampered with.

!!! tip "Keep the secret safe"
    The secret is write-only: the list and form show only whether a secret is set,
    never its value. Store your copy securely on the receiving end.

## Test a webhook

Each webhook in the list has a **Send test** action. It fires a sample delivery
right away and shows you the result — the response status code, or the error if it
failed — so you can confirm the URL, headers, and TLS settings are correct before
relying on it.

## Permissions and audit

Webhooks are managed by users with the **Integrations** permission group, and
every create, edit, and delete is recorded in the [change log](change-log.md).

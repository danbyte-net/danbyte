"""The canonical "is this model field a secret?" classifier.

Single source of truth shared by the audit trail, the generic import/export
handlers, and public share snapshots — so a credential field scrubbed from
the change log can never sneak out through a spreadsheet export or a public
share link instead.

EncryptedJSONField columns decrypt transparently on read (a naive getattr()
yields plaintext), so they're always secret. Detection is by class name
rather than an import to keep this module dependency-free (monitoring defines
the field; core must not import monitoring).
"""
from __future__ import annotations

_SECRET_FIELD_NAMES = {
    "secret", "secrets", "secret_params", "token", "password",
    "api_key", "private_key",
}

# Per-model extras where a generically-named field carries credentials
# (NotificationChannel.config holds PagerDuty routing keys / webhook URLs).
_SECRET_MODEL_FIELDS = {
    "monitoring.notificationchannel": {"config"},
    # Free-text extra request headers routinely carry Authorization / X-Api-Key
    # tokens — treat as secret for export / audit / any snapshot.
    "integrations.webhook": {"additional_headers"},
}


def is_secret_field(model_or_instance, field) -> bool:
    """True when ``field`` on this model must never leave the server in
    cleartext — not in audit snapshots, exports, or share links."""
    if type(field).__name__ == "EncryptedJSONField":
        return True
    if field.name in _SECRET_FIELD_NAMES:
        return True
    label = model_or_instance._meta.label_lower
    return field.name in _SECRET_MODEL_FIELDS.get(label, set())

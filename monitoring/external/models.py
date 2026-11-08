"""Abstract rows every external monitor keeps, in its own tables.

Each system keeps concrete tables of its own - a link per device, a review
queue, adoption rules - because the rows already hold live data under their
own API, RBAC object types and constraints. What they share is declared once
here: the fields whose meaning is the same in every system, and the behaviour
that reads them.

Only fields that are identical in every system live here. Anything that
differs per system - the tenant and connection foreign keys (their reverse
names are per system), the remote id, the kind choices, constraints and
ordering - stays on the concrete model. Abstract bases add no table, so
moving a field onto one is not a schema change as long as its definition does
not change.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

from django.db import models

from core.models import TimestampedModel


class ExternalLinkBase(TimestampedModel):
    """The durable pairing between a Danbyte device and a remote object.

    Stored rather than re-derived every pass, because every other way of
    matching - address, serial, name - is a guess that a rename or a
    re-addressing breaks. Once a pairing is established it survives both.

    ``created_here`` is what makes pruning safe: Danbyte will only ever
    consider removing a remote object it made itself.

    Concrete models add ``tenant``, ``connection``, ``device`` and the
    remote id.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    #: How the pairing was first made: link | address | serial | name |
    #: created | adopted - whatever levels the system's cascade has.
    matched_by = models.CharField(max_length=16, blank=True, default="")
    #: Danbyte created this remote object, so Danbyte may remove it.
    created_here = models.BooleanField(default=False)
    last_seen_at = models.DateTimeField(null=True, blank=True)
    #: First pass that found no reason for this object any more. Cleared the
    #: moment there is one again.
    unwanted_since = models.DateTimeField(null=True, blank=True)

    class Meta:
        abstract = True

    def mark_unwanted(self, now) -> None:
        """Start the grace clock, once. Saved only when it was not running."""
        if self.unwanted_since is None:
            self.unwanted_since = now
            self.save(update_fields=["unwanted_since"])

    def prune_due(self, now, grace_days) -> bool:
        """Whether the grace has run out on an unwanted object."""
        return (
            self.unwanted_since is not None
            and now - self.unwanted_since >= timedelta(days=grace_days)
        )


class ExternalChangeBase(TimestampedModel):
    """One proposed write, waiting for a person.

    A change is a **proposal**, never a record of something done: applying
    one deletes it. A pass proposes what is true now (:meth:`propose`) and
    drops what it did not propose again (:meth:`drop_stale`), so the queue
    never holds a proposal for something that is no longer true.

    Concrete models add ``tenant``, ``connection``, ``device`` (nullable -
    adoption proposals have none), ``kind`` with the system's choices, and
    their uniqueness.
    """

    #: Needs a person; "apply all" never guesses on its behalf.
    AMBIGUOUS = "ambiguous"
    #: The kind that adopts a remote object into Danbyte, if the system has
    #: one. Set by the concrete model.
    ADOPT: str | None = None

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    #: What would be written, and why - rendered for the operator to read
    #: before they agree to it.
    detail = models.JSONField(default=dict, blank=True)
    #: Dismissed: kept so detection does not re-raise it every pass.
    ignored = models.BooleanField(default=False)

    class Meta:
        abstract = True

    #: Kinds "apply all" skips.
    @classmethod
    def unattended_skip(cls) -> tuple:
        return (cls.AMBIGUOUS,)

    @classmethod
    def propose(cls, conn, fresh: set, detail: dict, **lookup):
        """Create or refresh one proposal and record it as seen this pass.

        ``lookup`` is the row's identity within the connection (device and
        kind, plus whatever key the system adds).
        """
        change, _ = cls.objects.update_or_create(
            connection=conn, **lookup,
            defaults={"tenant": conn.tenant, "detail": detail},
        )
        fresh.add(change.id)
        return change

    @classmethod
    def pending(cls, conn):
        """The connection's queue: proposals nobody has dismissed."""
        return cls.objects.filter(connection=conn, ignored=False)

    @classmethod
    def drop_stale(cls, conn, fresh) -> int:
        """Delete the queue's proposals this pass did not make again.

        A proposal nobody has looked at, for something that is no longer
        true, is worse than no proposal. Dismissed rows are kept.
        """
        deleted, _ = cls.pending(conn).exclude(id__in=fresh).delete()
        return deleted

    @classmethod
    def applicable(cls, conn):
        """What "apply all" and auto mode work through."""
        return cls.pending(conn).exclude(kind__in=cls.unattended_skip())


class ExternalAdoptionRuleBase(TimestampedModel):
    """Where an adopted remote object lands, decided by what it looks like.

    A rule matches a pattern - glob by default, ``regex:`` for a regular
    expression, a CIDR for addresses - against one of the object's
    attributes (the concrete model's ``scope`` choices say which) and names
    the site, and optionally the role and type, the device is made with.
    First match wins, in weight order; a rule only sets what it names.

    Concrete models add ``tenant``, ``connection``, ``scope`` and ``site``.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    pattern = models.CharField(
        max_length=255,
        help_text=(
            "Glob such as kbh-* or *-core?. Prefix with regex: for a regular "
            "expression. An address rule may be a CIDR."
        ),
    )
    role = models.ForeignKey(
        "api.DeviceRole", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
    )
    device_type = models.ForeignKey(
        "api.DeviceType", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
    )
    #: Lower runs first. Ties fall to the pattern, so the order is stable.
    weight = models.PositiveSmallIntegerField(default=100)
    enabled = models.BooleanField(default=True)

    class Meta:
        abstract = True

"""Django's ``migrate``, with the hooks Danbyte's upgrades need.

While ``core.upgrade_migrate.run_migrate`` holds the whole plan in one
transaction, each finished migration checks the deferred constraints it
left behind (``SET CONSTRAINTS ALL IMMEDIATE``) and defers them again for
the next one - what a commit between the two would have done, so a data
migration that briefly breaks a deferred foreign key still works, and a
later ``ALTER TABLE`` never meets "pending trigger events". Outside that
wrapper this is Django's command unchanged.
"""
from __future__ import annotations

from django.core.management.commands.migrate import Command as DjangoMigrate

from core import upgrade_migrate


class Command(DjangoMigrate):
    def migration_progress_callback(self, action, migration=None, fake=False):
        super().migration_progress_callback(action, migration, fake)
        alias = upgrade_migrate.flushing()
        if alias and action == "apply_success" and not fake:
            upgrade_migrate.flush_deferred(alias)

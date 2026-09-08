from django.apps import AppConfig


class BackupsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "backups"
    verbose_name = "Backup and restore"

from django.apps import AppConfig


class PlanningConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "planning"

    def ready(self):
        # Tasks become pickable/linkable objects everywhere (object custom
        # fields, bulk label resolution via /api/customization/object-labels/).
        from customization.object_registry import (
            ReferenceModel,
            register_reference_model,
        )

        register_reference_model(
            ReferenceModel(
                "task", "Tasks", "planning.Task", "/api/planning/tasks/",
                label_field="title", picker=False, route=None,
            )
        )

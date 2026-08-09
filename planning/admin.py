from django.contrib import admin

from .models import (
    Board,
    Milestone,
    PlannedChange,
    Task,
    TaskLabel,
    TaskLink,
    TaskStatus,
)

admin.site.register(Board)
admin.site.register(TaskStatus)
admin.site.register(TaskLabel)
admin.site.register(Milestone)
admin.site.register(Task)
admin.site.register(TaskLink)
admin.site.register(PlannedChange)

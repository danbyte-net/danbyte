from django.contrib import admin

from .models import Board, Task, TaskLabel, TaskLink, TaskStatus

admin.site.register(Board)
admin.site.register(TaskStatus)
admin.site.register(TaskLabel)
admin.site.register(Task)
admin.site.register(TaskLink)

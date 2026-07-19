from django.contrib import admin
from django.utils.html import format_html

from .models import Bookmark, BookmarkFolder, Organization, Tag, TaggedItem


@admin.register(Organization)
class OrganizationAdmin(admin.ModelAdmin):
    list_display = ["name", "slug", "created_at"]
    search_fields = ["name", "slug"]
    prepopulated_fields = {"slug": ("name",)}


@admin.register(Tag)
class TagAdmin(admin.ModelAdmin):
    list_display = ["name", "swatch", "slug"]
    search_fields = ["name", "slug"]
    prepopulated_fields = {"slug": ("name",)}

    @admin.display(description="Color", ordering="color")
    def swatch(self, obj):
        if not obj.color:
            return format_html('<span style="color:#999">— colorless —</span>')
        return format_html(
            '<span style="display:inline-block;width:14px;height:14px;border-radius:5px;'
            'background:{0};vertical-align:middle;margin-right:8px;'
            'border:1px solid rgba(0,0,0,0.1)"></span>'
            '<code style="font-size:11px">{0}</code>',
            obj.color,
        )


admin.site.register(TaggedItem)
admin.site.register(Bookmark)
admin.site.register(BookmarkFolder)

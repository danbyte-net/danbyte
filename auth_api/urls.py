from django.contrib.auth.models import User
from django.urls import path

from api import bulk
from . import views, column_prefs


app_name = "auth_api"


# ─── Bulk-action view ──────────────────────────────────────────────────
# Same factory the API list pages use. Users are global (no tenant FK), so
# tenant_field is empty.
user_bulk = bulk.bulk_action_view(
    model=User,
    delete_perm="users.manage",
    redirect_url="/auth/users/",
    tenant_field="",
    label_plural="users",
)


urlpatterns = [
    path("login/", views.login_view, name="login"),
    path("logout/", views.logout_view, name="logout"),
    path("users/", views.user_list, name="users"),
    path("users/new/", views.user_create, name="user-create"),
    path("users/_bulk/", user_bulk, name="user-bulk"),
    path("users/<int:pk>/edit/", views.user_edit, name="user-edit"),
    path("users/<int:pk>/delete/", views.user_delete, name="user-delete"),

    # Settings
    path("settings/", views.user_settings, name="user-settings"),
    path("settings/admin/", views.admin_tenant_settings, name="admin-settings"),

    # Per-user column preferences (used by static/columns.js).
    path("prefs/columns/<slug:table_id>/", column_prefs.column_pref, name="column-pref"),
    path("prefs/columns/<slug:table_id>/default/", column_prefs.column_pref_default,
         name="column-pref-default"),
]

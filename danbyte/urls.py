"""Top-level URL configuration."""
from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path
from django.views.generic import RedirectView

urlpatterns = [
    path("admin/", admin.site.urls),
    path("django-rq/", include("django_rq.urls")),
    # /api/* — REST endpoints for the v2 React frontend
    path("api/", include("api.api_urls")),
    # Root → React app. The old HTML urlconfs (api.urls, auth_api.urls)
    # are NOT included because their templates were archived to
    # reference/. Log in via Django admin at /admin/login/ — that sets the
    # session cookie the React app needs.
    path("", RedirectView.as_view(url="http://localhost:3000/", permanent=False)),
]

if settings.DEBUG and settings.STATICFILES_DIRS:
    urlpatterns += static(
        settings.STATIC_URL, document_root=settings.STATICFILES_DIRS[0]
    )
# Serve uploaded media (device-type rack images). In production nginx should
# front /media/ directly; this keeps the dev runserver working too.
urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)

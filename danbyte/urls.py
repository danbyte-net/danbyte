"""Top-level URL configuration."""
from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path, re_path
from django.views.generic import RedirectView

from api.media_views import serve_media
from core.site_tls_api import acme_challenge

urlpatterns = [
    path("admin/", admin.site.urls),
    # HTTP-01 for the site's own certificate, answered by Danbyte itself;
    # nginx hands this path through (deploy/nginx/*.template).
    path(".well-known/acme-challenge/<str:token>", acme_challenge, name="acme-challenge"),
    path("django-rq/", include("django_rq.urls")),
    # /api/* - REST endpoints for the v2 React frontend
    path("api/", include("api.api_urls")),
    # Root → React app. The old HTML urlconfs (api.urls, auth_api.urls)
    # are NOT included because their templates were archived to
    # reference/. Log in via Django admin at /admin/login/ - that sets the
    # session cookie the React app needs.
    path("", RedirectView.as_view(url="http://localhost:3000/", permanent=False)),
]

if settings.DEBUG and settings.STATICFILES_DIRS:
    urlpatterns += static(
        settings.STATIC_URL, document_root=settings.STATICFILES_DIRS[0]
    )
# Uploaded media, always through Django: public folders to anyone, the rest
# only to a user who can view the owning object (api.media_views, #227).
# nginx proxies /media/ here rather than serving the folder from disk.
urlpatterns += [
    re_path(r"^media/(?P<path>.+)$", serve_media, name="media"),
]

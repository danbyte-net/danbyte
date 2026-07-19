FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# libldap2-dev / libsasl2-dev / libssl-dev are needed to build python-ldap
# (pulled in by django-auth-ldap); without them the wheel fails on `lber.h`.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential libpq-dev libldap2-dev libsasl2-dev libssl-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["python", "manage.py", "runserver", "0.0.0.0:8000"]

#!/bin/bash

python manage.py collectstatic --noinput # run this to get all the static files in the same (correct) directory
python manage.py migrate

python manage.py loaddata /data/fixtures.json

wasmer config set registry.url "$BACKEND_BASE_URL"

uvicorn wapm.asgi:application --host 0.0.0.0 --port 8080 --workers 5

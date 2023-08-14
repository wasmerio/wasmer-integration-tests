#!/bin/bash

celery --app wapm worker -n default --loglevel INFO --concurrency 1 --queues default,backend_tasks,user_tasks_js_bindings,user_tasks_executables,user_tasks_python_bindings

from subprocess import check_call, check_output
from shlex import split
from json import loads
from os import mkdir
from time import time_ns
from pytest import fixture

def test_app_listing(tmpdir):
    app_names = []
    for i in range(11):
        app_name = f"test_app_listing-{time_ns()}-{i}"
        app_dir = f"{tmpdir}/{app_name}"
        mkdir(app_dir)
        check_call(split(f"wasmer app create --non-interactive --type http --package cypress1/test-app@0.2.0 --owner cypress1 --name {app_name} --no-wait"), cwd=app_dir)
        app_names.append(app_name)

    page = loads(check_output(split(f"wasmer app list --format json")))
    for app_name in app_names:
        assert app_name in [page_item["name"] for page_item in page]

    for app_name in app_names:
        check_call(split(f"wasmer app delete --non-interactive {app_name}"))
        
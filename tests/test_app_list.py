from subprocess import check_call, check_output
from shlex import split
from json import loads
from os import mkdir
from uuid import uuid4

def test_app_listing(tmpdir):
    app_names = []
    # until the wasmer cli is fixed to enable muliple page response on app list, this test only tests with 1 app
    for i in range(1):
        app_name = f"app_listing{uuid4()}-{i}"
        app_dir = f"{tmpdir}/{app_name}"
        mkdir(app_dir)
        check_call(split(f"wasmer app create --non-interactive --type http --package cypress1/test-app@0.2.0 --owner cypress1 --name {app_name} --no-wait"), cwd=app_dir)
        app_names.append(app_name)

    page = loads(check_output(split(f"wasmer app list --format json")))
    for app_name in app_names:
        assert app_name in [page_item["name"] for page_item in page]

    for app_name in app_names:
        check_call(split(f"wasmer app delete --non-interactive {app_name}"))
        
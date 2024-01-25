from subprocess import check_call, check_output, run
from shlex import split
from yaml import safe_load
from time import time_ns
from re import search, MULTILINE

def test_app_info_get(tmpdir):
    app_name = f"test_app_info_get-{time_ns()}"
    app_create_output = run(split(f"wasmer app create --non-interactive --type http --package cypress1/test-app@0.2.0 --owner cypress1 --name {app_name} --no-wait"), cwd=tmpdir, capture_output=True).stderr.decode()

    app_url = search("App URL: (.*)", app_create_output, flags=MULTILINE).group(1)
    versioned_url = search("Versioned URL: (.*)", app_create_output, flags=MULTILINE).group(1)
    
    info_output = run(split(f"wasmer app info {app_name}"), capture_output=True).stderr.decode()
    assert app_name == search("App Name: (.*)", info_output, flags=MULTILINE).group(1)
    assert app_url == search("App URL: (.*)", info_output, flags=MULTILINE).group(1)
    assert versioned_url == search("Versioned URL: (.*)", info_output, flags=MULTILINE).group(1)
    
    get_output = safe_load(run(split(f"wasmer app get {app_name}"), capture_output=True).stdout.decode())
    assert app_name == get_output["name"]
    assert app_url == get_output["url"]
    assert versioned_url == get_output["active_version"]["url"]
    check_call(split(f"wasmer app delete --non-interactive {app_name}"))
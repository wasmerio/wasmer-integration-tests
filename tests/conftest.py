import os
import pytest
import pathlib
from .helpers import deploy_app, AppHostName
from subprocess import run
from shlex import split
from pathlib import Path
from requests import get
from time import sleep

EDGE_HOST = os.environ.get("EDGE_HOST", "127.0.0.1")
EDGE_PORT = os.environ.get("EDGE_PORT", "8080")
EDGE_SCHEME = os.environ.get("EDGE_SCHEME", "http")
_edge_url = os.environ.get("EDGE_URL", f"{EDGE_SCHEME}://{EDGE_HOST}:{EDGE_PORT}")


@pytest.fixture(scope="session")
def edge_url() -> str:
    return _edge_url


@pytest.fixture(scope="module")
def wasix_echo_server_hostname() -> AppHostName:
    path = pathlib.Path(__file__).parent.parent / "packages" / "wasix-echo-server"
    return deploy_app(path)


@pytest.fixture(scope="module")
def test_app_hostname() -> AppHostName:
    path = pathlib.Path(__file__).parent.parent / "packages" / "test-app"
    return deploy_app(path)

@pytest.fixture(scope="module")
def echo_server():
    run(split("wasmer deploy --publish-package --no-wait --non-interactive"), check=True, cwd=Path(__file__).parent.parent / "packages" / "wasix-echo-server")
    wait_until_app_ready("wasix-echo-server")

def publish_local_package(path):
    publish = run(split("wasmer publish"), cwd=path, capture_output=True)
    assert(publish.returncode == 0 or "already exists" in publish.stderr.decode())
    sleep(10)

@pytest.fixture(scope="module")
def publish_static_web_server():
    publish_local_package(Path(__file__).parent.parent / "packages" / "static-web-server")

@pytest.fixture(scope="module")
def publish_test_app(publish_static_web_server):
    publish_local_package(Path(__file__).parent.parent / "packages" / "test-app")

@pytest.fixture(scope="module")
def deploy_test_app(publish_test_app):
    run(split("wasmer deploy --no-wait --non-interactive"), check=True, cwd=Path(__file__).parent.parent / "packages" / "test-app")
    wait_until_app_ready("test-app")

def app_hostname(appname):
    return f"{appname}-cypress1.wasmer.app"
    
def wait_until_app_ready(appname):
    i = 5
    while i > 0: 
        status = get("http://localhost", headers={"Host": app_hostname(appname)}, timeout=30).status_code
        if status == 200:
            return
        sleep(3)
        i -= 1
    assert False
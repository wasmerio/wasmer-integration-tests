import os
import pytest
import pathlib
from .helpers import deploy_app, AppHostName

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

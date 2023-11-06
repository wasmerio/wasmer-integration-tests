import requests
import toml
from pprint import pprint
import pathlib
import subprocess
import re
import pytest

from ..helpers import deploy_app, AppHostName


@pytest.fixture(scope="module")
def wasix_echo_server_hostname() -> AppHostName:
    path = (
        pathlib.Path(__file__).parent.parent.parent / "packages" / "wasix-echo-server"
    )
    return deploy_app(path)

def test_proxy_echo_server_get(wasix_echo_server_hostname):
    url = "http://127.0.0.1/hello?format=json"

    res = requests.get(url, headers={"host": wasix_echo_server_hostname})
    assert res.status_code == 200

    data = res.json()
    del data["headers"]["user-agent"]
    assert data == {
        "method": "GET",
        "uri": "/hello?format=json",
        "body": "",
        "headers": {
            "accept": "*/*",
            "accept-encoding": "gzip, deflate",
            "connection": "keep-alive",
            "forwarded": "for=127.0.0.1;by=127.0.0.1;",
            "host": "wasix-echo-server.wasmer.app",
        },
    }


def test_proxy_echo_server_head(wasix_echo_server_hostname):
    url = "http://127.0.0.1/hello?format=json"

    res = requests.head(url, headers={"host": wasix_echo_server_hostname})
    assert res.status_code == 200
    assert res.text == ""


def test_proxy_echo_server_post(wasix_echo_server_hostname):
    url = "http://127.0.0.1/hello?format=json"

    res = requests.post(url, headers={"Host": wasix_echo_server_hostname}, data="body")
    assert res.status_code == 200

    data = res.json()
    del data["headers"]["user-agent"]
    assert data == {
        "method": "POST",
        "uri": "/hello?format=json",
        "body": "",
        "headers": {
            "accept": "*/*",
            "accept-encoding": "gzip, deflate",
            "connection": "keep-alive",
            "forwarded": "for=127.0.0.1;by=127.0.0.1;",
            "host": "wasix-echo-server.wasmer.app",
            "transfer-encoding": "chunked",
        },
    }

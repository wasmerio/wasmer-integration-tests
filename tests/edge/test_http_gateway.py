import os
import requests
import toml
from pprint import pprint
import pathlib
import subprocess
import re
import pytest


def test_proxy_echo_server_get(echo_server, wasix_echo_server_hostname, edge_url):
    url = f"{edge_url}/hello?format=json"

    res = requests.get(url, headers={"host": wasix_echo_server_hostname})
    assert res.status_code == 200

    data = res.json()
    del data["headers"]["user-agent"]
    del data["headers"]["forwarded"]
    del data["uri"]
    assert data == {
        "method": "GET",
        "body": "",
        "headers": {
            "accept": "*/*",
            "accept-encoding": "gzip, deflate",
            "connection": "keep-alive",
            "host": wasix_echo_server_hostname,
        },
    }


def test_proxy_echo_server_head(echo_server, wasix_echo_server_hostname, edge_url):
    url = f"{edge_url}/hello?format=json"

    res = requests.head(url, headers={"host": wasix_echo_server_hostname})
    assert res.status_code == 200
    assert res.text == ""


def test_proxy_echo_server_post(echo_server, wasix_echo_server_hostname, edge_url):
    url = f"{edge_url}/hello?format=json"

    res = requests.post(url, headers={"Host": wasix_echo_server_hostname}, data="body")
    assert res.status_code == 200

    data = res.json()
    del data["headers"]["user-agent"]
    del data["headers"]["forwarded"]
    del data["uri"]
    assert data == {
        "method": "POST",
        "body": "body",
        "headers": {
            "accept": "*/*",
            "accept-encoding": "gzip, deflate",
            "connection": "keep-alive",
            "content-length": "4",
            "host": wasix_echo_server_hostname,
        },
    }

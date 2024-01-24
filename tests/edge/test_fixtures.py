import requests


def test_test_app_is_accessable(test_app_hostname, edge_url):
    url = f"{edge_url}"

    res = requests.get(url, headers={"host": test_app_hostname})
    assert res.status_code == 200


def test_wasix_echo_server_is_accessable(wasix_echo_server_hostname, edge_url):
    url = f"{edge_url}"

    res = requests.get(url, headers={"host": wasix_echo_server_hostname})
    assert res.status_code == 200

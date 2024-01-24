import os
from typing import Optional
from pprint import pprint
import requests
import pathlib
import toml
import yaml
import subprocess
import re

REGISTRY_HOST = os.environ.get("REGISTRY_HOST", "127.0.0.1")
REGISTRY_PORT = os.environ.get("REGISTRY_PORT", "8080")
REGISTRY_SCHEME = os.environ.get("REGISTRY_SCHEME", "http")
registry = os.environ.get(
    "REGISTRY", f"{REGISTRY_SCHEME}://{REGISTRY_HOST}:{REGISTRY_PORT}/graphql"
)


def graphql_query(filename):
    filename = filename + ".graphql"
    filepath = os.path.join(
        os.path.dirname(os.path.realpath(__file__)),
        "graphql",
        filename,
    )
    with open(filepath) as f:
        return "".join([line for line in f])


def run_graphql_query(
    query,
    url=registry,
    variables=None,
    headers=None,
):
    """
    Run a GraphQL query on a server.

    Args:
        query (str): The GraphQL query to run.
        url (str, optional): The URL of the GraphQL server.
        variables (dict, optional): Variables for the query, if any.
        headers (dict, optional): Headers for the request, if any.

    Returns:
        dict: The response from the server as a dictionary.

    Example:
    query = '''
    query {
      search(query:"hello") {
        edges {
          node {
            __typename
          }
        }
      }
    }
    '''
    response_data = run_graphql_query(query)
    """
    payload = {"query": query}

    if variables:
        payload["variables"] = variables

    response = requests.post(url, json=payload, headers=headers)

    if response.status_code != 200:
        raise Exception(f"Failed to run GraphQL query: {response.text}")

    response_data = response.json()

    if "errors" in response_data:
        raise Exception(f"GraphQL errors: {response_data['errors']}")

    return response_data["data"]


def get_token_for_user(username, password):
    query = f"""
mutation {{
  tokenAuth(input:{{
    username: "{username}",
    password:"{password}"
  }}) {{
    token
  }}
}}"""
    res = run_graphql_query(query)
    assert res["tokenAuth"] is not None
    assert res["tokenAuth"]["token"] is not None
    return res["tokenAuth"]["token"]


def get_package_latest_version(name: str) -> Optional[str]:
    query = """
query ($name: String!) {
  getPackage(name: $name) {
    lastVersion {
      version
    }
  }
}
    """

    data = run_graphql_query(
        query, variables={"name": name}, headers=header_for_cypress1()
    )
    pprint(data)

    if data:
        return data.get("getPackage", {}).get("lastVersion", {}).get("version", None)
    return None


# Type alias
AppHostName = str


# Publish a package and app to the backend.
#
# Expects a path to a directory containing a wasmer.toml and app.yaml file.
def deploy_app(path: pathlib.Path) -> AppHostName:
    pkgtoml = path / "wasmer.toml"
    appyaml = path / "app.yaml"

    assert pkgtoml.is_file()
    assert appyaml.is_file()

    with open(pkgtoml, "r") as f:
        pkg = toml.load(f)

    pkg_name = pkg["package"]["name"]
    pkg_version = pkg["package"]["version"]

    with open(appyaml, "r") as f:
        yaml_data = yaml.load(f, yaml.Loader)
    app_name = yaml_data.get("name")
    if "app_id" in yaml_data.keys():
        yaml_data.pop("app_id")
    with open(appyaml, "w") as f:
        yaml.dump(yaml_data, f)
    if not app_name:
        raise ValueError("Could not find app name in app.yaml")

    # check if the package is already published
    latest = get_package_latest_version(pkg_name)
    if latest != pkg_version:
        subprocess.run(["wasmer", "publish", path], check=True)

    # execute the "wasmer" command and make sure it returns a success code
    # TODO: check if app needs an update (compare package version)
    subprocess.run(
        [
            "wasmer",
            "deploy",
            "--path",
            str(path),
            "--non-interactive",
            "--no-wait",
        ],
        check=True,
    )

    host = f"{app_name}.wasmer.app"
    return host


def header_for_cypress1():
    return {"Authorization": f"Bearer {get_token_for_user('cypress1', 'Qwe123!@#')}"}


def header_for_cypress2():
    return {"Authorization": f"Bearer {get_token_for_user('cypress2', 'Qwe123!@#')}"}


def header_for_wasmer():
    return {"Authorization": f"Bearer {get_token_for_user('wasmer', 'Qwe123!@#')}"}


def header_for_ordinary_user():
    return {
        "Authorization": f"Bearer {get_token_for_user('ordinary_user', 'Qwe123!@#')}"
    }

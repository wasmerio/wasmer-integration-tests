import os

import requests


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
    url="http://localhost:8080/graphql",
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


def header_for_cypress1():
    return {"Authorization": f"Bearer {get_token_for_user('cypress1', 'Qwe123!@#')}"}


def header_for_cypress2():
    return {"Authorization": f"Bearer {get_token_for_user('cypress2', 'Qwe123!@#')}"}


def header_for_wasmer():
    return {"Authorization": f"Bearer {get_token_for_user('wasmer', 'Qwe123!@#')}"}


def header_for_ordinary_user():
    return {"Authorization": f"Bearer {get_token_for_user('ordinary_user', 'Qwe123!@#')}"}

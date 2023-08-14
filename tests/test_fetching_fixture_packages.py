from .helpers import graphql_query, run_graphql_query


def test_fetching_app(snapshot):
    query = graphql_query("query-static-web-server")
    response = run_graphql_query(query)
    snapshot.assert_match(response)

from .helpers import graphql_query, run_graphql_query


def test_fetching_app(publish_static_web_server, snapshot):
    query = graphql_query("query-static-web-server")
    response = run_graphql_query(query)
    snapshot.assert_match(response)

use futures::stream::TryStreamExt;
use test_log;

use crate::{api_client, ensure_clean_dir, http_client, test_app_tmp_dir, test_namespace};

#[test_log::test(tokio::test)]
async fn test_python_logging() {
    let name = "wasmer-test-logging-python".to_string();
    let namespace = test_namespace();

    let now = time::OffsetDateTime::now_utc();

    // Create Python app.
    let client = api_client();

    let dir = test_app_tmp_dir().join(&name);
    ensure_clean_dir(&dir).expect("Failed to ensure clean dir");
    let main_py = dir.join("src/main.py");

    tracing::debug!(local_path=%dir.display(), "creating app with cli");

    let status = std::process::Command::new("wasmer")
        .args(&[
            "app",
            "create",
            "-t",
            "py-application",
            "--non-interactive",
            "--offline",
            "--owner",
            &namespace,
            "--new-package-name",
            &name,
            "--name",
            &name,
            "--path",
            dir.to_str().unwrap(),
        ])
        .spawn()
        .expect("Failed to invoke 'wasmer app create'")
        .wait()
        .expect("'wasmer app create' command failed");
    if !status.success() {
        panic!(
            "'wasmer app create' command failed with status: {:?}",
            status
        );
    }

    // Update the code to add some logging.

    let code = r#"
    import os
    import json
    import urllib.parse
    import sys
    from http.server import SimpleHTTPRequestHandler, HTTPServer


    class CustomHandler(SimpleHTTPRequestHandler):
        def do_GET(self):
            # get invocation id query param
            url = urllib.parse.urlparse(self.path)
            query = urllib.parse.parse_qs(url.query)
            request_id = query.get('request-id', ['<no-request-id>']).pop()

            # print to stdout
            print(f"GET {self.path}")
            # print to stderr
            print(f"GET {self.path}", file=sys.stderr)
            self.send_response(200)

            self.send_header('Content-type', 'application/json')
            self.end_headers()

            data = {
                "message": "wasmer-tests/wasmer-tests-python-logging is running on Python!"
            }
            self.wfile.write(json.dumps(data).encode('utf-8'))


    if __name__ == "__main__":
        host = os.environ.get('HOST', '127.0.0.1')

        # Get the PORT environment variable if it's present; otherwise, default to 8000
        port = int(os.environ.get('PORT', 8080))

        server = HTTPServer((host, port), CustomHandler)
        print(f"Starting server on http://{host}:{port}")
        server.serve_forever()
        "#;

    fs_err::write(&main_py, code).expect("Failed to write to main.py");

    let status = std::process::Command::new("wasmer")
        .args(&[
            "deploy",
            "--publish-package",
            "--no-persist-id",
            "--path",
            dir.to_str().unwrap(),
        ])
        .spawn()
        .expect("Failed to invoke 'wasmer deploy'")
        .wait()
        .expect("'wasmer deploy' command failed");

    if !status.success() {
        panic!("'wasmer deploy' command failed with status: {:?}", status);
    }

    // Query the app.

    let app = wasmer_api::backend::get_app(&client, namespace.clone(), name.clone())
        .await
        .expect("could not query app")
        .expect("queried app is None");
    tracing::debug!("app deployed, sending request");

    let id = uuid::Uuid::new_v4();
    let mut url = app
        .url
        .parse::<url::Url>()
        .expect("Failed to parse app URL");
    url.query_pairs_mut()
        .append_pair("request-id", &id.to_string());

    let _res = http_client()
        .get(url)
        .send()
        .await
        .expect("Failed to send request")
        .error_for_status()
        .expect("Failed to get response");

    let stream = wasmer_api::backend::get_app_logs_paginated(
        &client,
        name.clone(),
        namespace.clone(),
        None,
        now,
        None,
        true,
    )
    .await;
    let mut stream = Box::pin(stream);

    tracing::info!("Waiting for logs with id {id}");
    'OUTER: while let Some(logs) = stream.try_next().await.expect("could not get logs") {
        for log in logs {
            if log.message.contains(&id.to_string()) {
                tracing::info!("Found log: {}", log.message);
                break 'OUTER;
            } else {
                tracing::debug!("ignoring non-matching log line: '{}'", log.message);
            }
        }
    }
}
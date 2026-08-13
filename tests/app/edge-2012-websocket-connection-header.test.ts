// WebSocket clients must receive a real RFC 6455 handshake from an app.
// Edge must forward `Connection: Upgrade` instead of replacing it with
// `Connection: close`: https://linear.app/wasmer/issue/EDGE-2012
// This test is expected to remain red until the Edge fix reaches the target
// environment; coordinate through the ticket rather than skipping it.
import WebSocket from "ws";
import { AppInfo, TestEnv } from "../../src";
import { buildPythonApp } from "../../src/app/construct";

const WEBSOCKET_SERVER = String.raw`
import base64
import hashlib
import socket

MAGIC = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

def serve():
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("localhost", 8080))
    listener.listen(5)
    while True:
        client, _ = listener.accept()
        request = client.recv(4096).decode("utf-8", errors="replace")
        headers = {}
        for line in request.split("\r\n"):
            if ":" in line:
                key, value = line.split(":", 1)
                headers[key.lower()] = value.strip()

        if headers.get("connection", "").lower() != "upgrade":
            client.sendall(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
            client.close()
            continue

        key = headers["sec-websocket-key"].encode("ascii")
        accept = base64.b64encode(hashlib.sha1(key + MAGIC).digest()).decode("ascii")
        client.sendall((
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
        ).encode("ascii"))
        client.close()

serve()
`;

function connectWebSocket(env: TestEnv, app: AppInfo): Promise<WebSocket> {
  const appUrl = new URL(app.url);
  const target = env.edgeServer
    ? new URL(env.edgeServer)
    : new URL(app.url.replace(/^http/, "ws"));
  target.pathname = appUrl.pathname;
  target.search = appUrl.search;

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target, {
      headers: {
        Host: appUrl.host,
        ...(env.edgeServer
          ? { "X-Forwarded-Proto": appUrl.protocol.slice(0, -1) }
          : {}),
      },
      handshakeTimeout: 60_000,
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

test.concurrent(
  "Edge forwards WebSocket Connection Upgrade to the workload",
  async () => {
    const env = TestEnv.fromEnv();
    let app: AppInfo | undefined;

    try {
      app = await env.deployApp(buildPythonApp(WEBSOCKET_SERVER), {
        noWait: false,
      });
      const socket = await connectWebSocket(env, app);
      socket.close();
    } finally {
      if (app) {
        await env.deleteApp(app);
      }
    }
  },
  180_000,
);

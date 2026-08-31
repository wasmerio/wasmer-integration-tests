// The database peer, in-process. A repro that needs a container started by
// hand is a repro that does not get run, so the harness carries its own peer:
// it speaks just enough of the Postgres startup handshake for the probe's
// connect/close cycle, and nothing else.
//
// TLS is not optional here. On a plaintext peer the guest grows ~1.1 KB per
// cycle and plateaus; on the TLS arm — the one a managed app database forces,
// and the one prod takes — it grows ~85 KB per cycle and never stops. The
// certificate is generated per run rather than committed, so no private key
// lives in the repo.

import net from "node:net";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// AuthenticationCleartextPassword: enough for the client to see a reply and
// close. Completing SCRAM would add nothing to what is measured.
const AUTH_REPLY = (() => {
  const b = Buffer.alloc(9);
  b.write("R", 0, "latin1");
  b.writeInt32BE(8, 1);
  b.writeInt32BE(3, 5);
  return b;
})();

function selfSignedPair() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ass-peer-"));
  try {
    execFileSync(
      "openssl",
      [
        "req", "-new", "-x509", "-days", "1", "-nodes",
        "-newkey", "rsa:2048",
        "-keyout", path.join(dir, "key.pem"),
        "-out", path.join(dir, "cert.pem"),
        "-subj", "/CN=localhost",
      ],
      { stdio: "ignore" },
    );
    return {
      key: readFileSync(path.join(dir, "key.pem")),
      cert: readFileSync(path.join(dir, "cert.pem")),
    };
  } catch (err) {
    throw new Error(
      `the peer needs openssl to mint a throwaway certificate: ${err.message}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function startPeer({ host = "127.0.0.1", port = 0, useTls = true } = {}) {
  // Plaintext is the A/B arm: the same cycle without a handshake leaks ~1.1 KB
  // per cycle instead of ~85 KB, which is what localises the defect to TLS.
  const creds = useTls ? selfSignedPair() : null;

  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    // The client opens with an SSLRequest on the bare socket; TLS starts only
    // after the peer agrees, exactly like a real server.
    socket.once("data", () => {
      if (!useTls) {
        socket.write("N");
        socket.on("data", () => socket.write(AUTH_REPLY));
        return;
      }
      socket.write("S");
      // A fresh context per connection: sharing one lets the client resume
      // sessions, which skips the full handshake and hides most of the cost
      // being measured. A real managed database does a full handshake here.
      const secure = new tls.TLSSocket(socket, {
        isServer: true,
        secureContext: tls.createSecureContext(creds),
      });
      secure.on("error", () => {});
      secure.on("data", () => secure.write(AUTH_REPLY));
    });
  });
  server.on("error", () => {});

  return new Promise((resolve) => {
    server.listen(port, host, () =>
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.unref();
          }),
      }),
    );
  });
}

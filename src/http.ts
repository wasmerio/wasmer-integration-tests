import http from "node:http";
import https from "node:https";
import { Buffer } from "node:buffer";
import { LookupFunction } from "node:net";
import { LookupAddress, LookupOptions } from "node:dns";

export interface ResponseExt extends Response {
  remoteAddress: string | undefined;
}

// Custom nodejs based http client.
//
// Needed to allow custom dns resolution and accepting invalid certs.
export class HttpClient {
  targetServer: string = "";

  fetch(url: string, options: RequestInit): Promise<ResponseExt> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const protocol = parsedUrl.protocol === "https:" ? https : http;

      const requestHeaders: http.OutgoingHttpHeaders = {};
      for (const [key, value] of Object.entries(options.headers ?? {})) {
        requestHeaders[key] = value;
      }

      let lookup: LookupFunction | undefined = undefined;
      if (this.targetServer) {
        const ipProto = this.targetServer.includes(":") ? 6 : 4;

        lookup = (
          _hostname: string,
          _options: LookupOptions,
          callback: (
            err: NodeJS.ErrnoException | null,
            address: string | LookupAddress[],
            family?: number,
          ) => void,
        ) => {
          callback(null, this.targetServer, ipProto);
          throw new Error("lookup called");
        };
      }

      const requestOptions = {
        method: options.method || "GET",
        headers: requestHeaders,
        lookup,
      };

      const req = protocol.request(parsedUrl, requestOptions, (res) => {
        const data: unknown[] = [];

        res.on("data", (chunk) => {
          data.push(chunk);
        });

        res.on("end", () => {
          const plainHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (value) {
              if (typeof value === "string") {
                plainHeaders[key] = value;
              } else {
                throw new Error(
                  `could not convert header value: ${key}: ${typeof value}`,
                );
              }
            }
          }

          const headers = new Headers(plainHeaders);
          if (
            !Array.isArray(data) ||
            !data.every((item) => item instanceof Uint8Array)
          ) {
            throw new Error("data is not of type Uint8Array[]");
          }

          const buffer = Buffer.concat(data);
          const bodyArray: Uint8Array = new Uint8Array(buffer);

          const status = res.statusCode || 0;
          const out: ResponseExt = {
            ok: status >= 200 && status < 300,
            status,
            statusText: res.statusMessage ?? "unknown",
            json: () => Promise.resolve(JSON.parse(buffer.toString())),
            text: () => Promise.resolve(buffer.toString()),
            bytes: () => Promise.resolve(bodyArray),
            arrayBuffer: () => Promise.resolve(buffer.buffer as ArrayBuffer),
            headers,
            url: res.url ?? "",
            body: null,
            redirected: false,
            bodyUsed: true,
            clone: () => {
              throw new Error("Not implemented");
            },
            blob: () => {
              throw new Error("Not implemented");
            },
            formData: () => {
              throw new Error("Not implemented");
            },
            type: "default",

            // Add non-standard field for remote address for debugging.
            remoteAddress: res.socket.remoteAddress,
          };
          resolve(out);
        });
      });

      req.on("error", (err) => {
        reject(err);
      });

      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });
  }
}

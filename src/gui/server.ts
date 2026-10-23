import fs from "node:fs";
import http, { type Server } from "node:http";
import { oneshotHash, parseOneshot, readLibrary } from "../core/library.js";
import { GUI_CSS, GUI_HTML, GUI_JS } from "./assets.js";

export interface GuiEntry {
  slug: string;
  title: string;
  body: string;
  domains: string[];
  authoredAt: string;
  sessions: number;
  confidence: string;
  rating: "up" | "down" | null;
  edited: boolean;
}

/** Expose only browsing data: source transcripts, config, and filesystem paths stay private. */
function librarySnapshot(home: string): { entries: GuiEntry[]; skipped: number } {
  const entries: GuiEntry[] = [];
  let skipped = 0;
  for (const entry of readLibrary(home)) {
    try {
      const content = fs.readFileSync(entry.oneshotPath, "utf8");
      const { title, body } = parseOneshot(content);
      const source = entry.sources;
      entries.push({
        slug: entry.slug,
        title: title || source.title || entry.slug,
        body,
        domains: source.domains,
        authoredAt: source.authored_at,
        sessions: source.members.length,
        confidence: source.confidence,
        rating: source.rating ?? null,
        edited: Boolean(source.oneshot_hash && source.oneshot_hash !== oneshotHash(content)),
      });
    } catch {
      skipped++;
    }
  }
  return { entries, skipped };
}

export interface GuiServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

/** A read-only loopback server. Port 0 asks the OS for an available port. */
export async function startGuiServer(opts: { home: string; port?: number }): Promise<GuiServer> {
  const port = opts.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("--port must be an integer between 0 and 65535 (0 chooses an available port).");
  }
  const hosts = new Set<string>();
  const server = http.createServer(
    { requestTimeout: 10_000, headersTimeout: 10_000 },
    (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-DNS-Prefetch-Control", "off");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      const send = (status: number, text: string, type = "text/plain; charset=utf-8") => {
        res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(text) });
        res.end(req.method === "HEAD" ? undefined : text);
      };
      // Loopback binding alone does not stop DNS rebinding or cross-site requests.
      // Never grant CORS access or accept a Host supplied by an unrelated website.
      if (
        !hosts.has(req.headers.host ?? "") ||
        (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) ||
        req.headers["sec-fetch-site"] === "cross-site"
      ) {
        send(403, "This library is available only from its local browser address.");
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.setHeader("Allow", "GET, HEAD");
        send(405, "Read-only library.");
        return;
      }
      // A fixed route table, never a URL-to-filesystem mapping.
      const route = req.url?.split("?")[0];
      switch (route) {
        case "/":
          send(200, GUI_HTML, "text/html; charset=utf-8");
          break;
        case "/app.css":
          send(200, GUI_CSS, "text/css; charset=utf-8");
          break;
        case "/app.js":
          send(200, GUI_JS, "text/javascript; charset=utf-8");
          break;
        case "/api/library":
          try {
            send(
              200,
              JSON.stringify(librarySnapshot(opts.home)),
              "application/json; charset=utf-8",
            );
          } catch {
            send(
              500,
              JSON.stringify({ error: "Could not read the library." }),
              "application/json; charset=utf-8",
            );
          }
          break;
        default:
          send(404, "Not found.");
      }
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine the GUI port.");
  hosts.add(`127.0.0.1:${address.port}`);
  hosts.add(`localhost:${address.port}`);
  let closing: Promise<void> | undefined;
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGui } from "../src/commands/gui.js";
import { oneshotHash } from "../src/core/library.js";
import { type GuiServer, startGuiServer } from "../src/gui/server.js";

let home: string;
const servers: GuiServer[] = [];
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cch-gui-"));
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  fs.rmSync(home, { recursive: true, force: true });
});

function prompt(slug: string, text: string, extra: Record<string, unknown> = {}): string {
  const dir = path.join(home, "library", slug);
  fs.mkdirSync(dir, { recursive: true });
  const content = `<!-- private provenance -->\n# Title of ${slug}\n\n${text}\n`;
  fs.writeFileSync(
    path.join(dir, "sources.json"),
    JSON.stringify({
      slug,
      title: "Original title",
      members: ["private-session.md"],
      domains: ["testing"],
      confidence: "high",
      authored_at: "2026-10-21T10:00:00Z",
      oneshot_hash: oneshotHash(content),
      source_paths: ["/private/transcript.jsonl"],
      ...extra,
    }),
  );
  const file = path.join(dir, `${slug}.oneshot.md`);
  fs.writeFileSync(file, content);
  return file;
}

async function start(): Promise<GuiServer> {
  const server = await startGuiServer({ home });
  servers.push(server);
  return server;
}

function request(
  server: GuiServer,
  route: string,
  opts: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const url = new URL(server.url);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: route,
        method: opts.method ?? "GET",
        headers: opts.headers,
        agent: false,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("local GUI server", () => {
  it("binds only to loopback on an available port and closes cleanly", async () => {
    const server = await start();
    expect(server.server.address()).toMatchObject({ address: "127.0.0.1" });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await server.close();
    await server.close();
    expect(server.server.listening).toBe(false);
  });

  it("serves only the small built-in UI assets, with restrictive browser headers", async () => {
    const server = await start();
    for (const [route, type] of [
      ["/", "text/html"],
      ["/app.css", "text/css"],
      ["/app.js", "text/javascript"],
    ]) {
      const response = await request(server, route ?? "");
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain(type);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
      expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    }
    const head = await request(server, "/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.text).toBe("");
    expect(Number(head.headers["content-length"])).toBeGreaterThan(0);
  });

  it("returns the exact copyable body and browsing metadata without private provenance", async () => {
    const text = 'Keep this <script>alert("not executable")</script> text.\n\n- Match my wording.';
    const file = prompt("example-task", text, { rating: "up" });
    const server = await start();
    const response = await request(server, "/api/library");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toEqual({
      entries: [
        {
          slug: "example-task",
          title: "Title of example-task",
          body: text,
          domains: ["testing"],
          confidence: "high",
          sessions: 1,
          authoredAt: "2026-10-21T10:00:00Z",
          rating: "up",
          edited: false,
        },
      ],
      skipped: 0,
    });
    expect(response.text).not.toContain("private");
    expect(response.text).not.toContain(file);
    expect((await request(server, "/")).text).not.toContain('alert("not executable")');
  });

  it("picks up local edits on refresh without rewriting anything", async () => {
    const file = prompt("editable-task", "Original body.");
    const server = await start();
    await request(server, "/api/library");
    fs.writeFileSync(file, "# My revised title\n\nMy revised prompt.");
    const response = JSON.parse((await request(server, "/api/library")).text);
    expect(response.entries[0]).toMatchObject({
      title: "My revised title",
      body: "My revised prompt.",
      edited: true,
    });
    expect(fs.readFileSync(file, "utf8")).toBe("# My revised title\n\nMy revised prompt.");
  });

  it("handles empty libraries and missing prompt files", async () => {
    const server = await start();
    expect(JSON.parse((await request(server, "/api/library")).text)).toEqual({
      entries: [],
      skipped: 0,
    });
    const file = prompt("missing-task", "Will be removed.");
    fs.unlinkSync(file);
    expect(JSON.parse((await request(server, "/api/library")).text)).toEqual({
      entries: [],
      skipped: 1,
    });
  });

  it("rejects cross-site origins, fetches, and rebinding hostnames", async () => {
    prompt("private-task", "Do not expose this to another website.");
    const server = await start();
    const cases: Record<string, string>[] = [
      { origin: "https://unrelated.example" },
      { "sec-fetch-site": "cross-site" },
      { host: "unrelated.example" },
      { origin: "http://127.0.0.1:1" },
    ];
    for (const headers of cases) {
      const response = await request(server, "/api/library", { headers });
      expect(response.status).toBe(403);
      expect(response.text).not.toContain("Do not expose");
    }
    expect(
      (await request(server, "/api/library", { headers: { origin: server.url } })).status,
    ).toBe(200);
  });

  it("has no mutation or arbitrary file routes", async () => {
    fs.writeFileSync(path.join(home, "private.txt"), "not part of the library");
    const server = await start();
    for (const route of [
      "/private.txt",
      "/../private.txt",
      "/%2e%2e/private.txt",
      "/api/library/private.txt",
    ]) {
      expect((await request(server, route)).status).toBe(404);
    }
    const response = await request(server, "/api/library", { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe("GET, HEAD");
  });
});

describe("gui command", () => {
  it("honors --home and --no-open and removes signal listeners when closed", async () => {
    prompt("selected-home-task", "From the selected home.");
    const openBrowser = vi.fn(async () => true);
    let text = "";
    const output = new Writable({
      write(chunk, _encoding, done) {
        text += chunk.toString();
        done();
      },
    });
    const before = process.listenerCount("SIGINT");
    const server = await runGui({ home, open: false }, { output, openBrowser });
    servers.push(server);
    expect(openBrowser).not.toHaveBeenCalled();
    expect(text).toContain(server.url);
    expect((await request(server, "/api/library")).text).toContain("From the selected home.");
    await server.close();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("opens the browser by default and keeps serving if the launcher fails", async () => {
    const output = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const openBrowser = vi.fn(async () => false);
    const server = await runGui({ home }, { output, openBrowser });
    servers.push(server);
    expect(openBrowser).toHaveBeenCalledWith(server.url);
    expect((await request(server, "/")).status).toBe(200);
  });

  it.each([
    "",
    "-1",
    "65536",
    "12px",
    "1.5",
  ])("rejects invalid port %s before opening a browser", async (port) => {
    const openBrowser = vi.fn(async () => true);
    await expect(runGui({ home, port }, { openBrowser })).rejects.toThrow("--port");
    expect(openBrowser).not.toHaveBeenCalled();
  });
});

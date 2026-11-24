import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGuiHandler, SECURITY_HEADERS } from "../src/gui/server.js";
import { SESSION_HEADER, SessionError, sessionApi } from "../src/gui/session.js";
import { guiHarness, type Harness, harnessFetch, request } from "./gui-harness.js";
import { type BuiltHome, sampleHome } from "./support/home.js";

/**
 * Who may read the library. Every route keeps the Host, Origin, and
 * `sec-fetch-site` checks; every `/api` route also needs the session key in
 * its header. Runs in process against the request handler (gui-harness.ts).
 */

// Nothing here writes to the home, so one home serves the whole file.
let home: BuiltHome;
let gui: Harness;
beforeAll(() => {
  home = sampleHome().build();
  gui = guiHarness(home.dir);
});
afterAll(() => home.remove());

const PAGE_ROUTES = ["/", "/app.css", "/app.js"];
const API_GET_ROUTES = [
  "/api/library",
  "/api/highlights",
  "/api/preferences/generalized",
  "/api/subagents",
  "/api/subagents/export.zip",
  "/api/subagents/export.zip?target=claude",
];
const REVIEW = "/api/preferences/review";
/** Text that exists only inside the library, never in a refusal. */
const PRIVATE_TEXT = ["Keep changes small", "keep the change small", "release notes"];

/** The 64-hex key with its last character changed. */
const nearMiss = () => `${gui.token.slice(0, -1)}${gui.token.endsWith("0") ? "1" : "0"}`;

const hostileOrigins: [string, Record<string, string>][] = [
  ["a rebinding Host", { host: "unrelated.example" }],
  ["a Host on another port", { host: "127.0.0.1:1" }],
  ["a cross-site Origin", { origin: "https://unrelated.example" }],
  ["an Origin on another port", { origin: "http://127.0.0.1:1" }],
  ["a cross-site fetch", { "sec-fetch-site": "cross-site" }],
];

function expectRefused(response: {
  status: number;
  text: string;
  headers: Record<string, string>;
}) {
  expect(response.status).toBe(403);
  for (const text of PRIVATE_TEXT) expect(response.text).not.toContain(text);
  expect(response.headers["content-disposition"]).toBeUndefined();
  expect(response.headers["access-control-allow-origin"]).toBeUndefined();
}

describe("every route refuses requests from outside this browser session", () => {
  const everyRoute = [...PAGE_ROUTES, ...API_GET_ROUTES, "/api/nothing-here"];
  it.each(
    everyRoute.flatMap((route) =>
      hostileOrigins.map(([label, headers]) => [route, label, headers]),
    ),
  )("%s refuses %s", async (route, _label, headers) => {
    expectRefused(
      await request(gui, route as string, { headers: headers as Record<string, string> }),
    );
  });

  it.each(hostileOrigins)("the review route refuses %s", async (_label, headers) => {
    expectRefused(
      await request(gui, REVIEW, {
        method: "POST",
        headers: { origin: gui.url, "content-type": "application/json", ...headers },
        body: {},
      }),
    );
  });
});

describe("every /api route needs the session key in its header", () => {
  const keys: [string, { token?: string | false; route?: (r: string) => string }][] = [
    ["no key", { token: false }],
    ["an empty key", { token: "" }],
    ["a wrong key", { token: "f".repeat(64) }],
    ["a key one character off", { token: "near-miss" }],
    ["a shorter prefix of the key", { token: "prefix" }],
    [
      "the key in the query string only",
      { token: false, route: (r) => `${r}${r.includes("?") ? "&" : "?"}token=KEY` },
    ],
  ];
  const resolve = (token: string | false | undefined) =>
    token === "near-miss" ? nearMiss() : token === "prefix" ? gui.token.slice(0, 32) : token;

  it.each(
    [...API_GET_ROUTES, "/api", "/api/nothing-here"].flatMap((route) =>
      keys.map(([label, key]) => [route, label, key] as const),
    ),
  )("%s refuses %s", async (route, _label, key) => {
    const path = key.route ? key.route(route).replace("KEY", gui.token) : route;
    const response = await request(gui, path, { token: resolve(key.token) as string | false });
    expectRefused(response);
    expect(response.text).toContain("address printed in your terminal");
  });

  it.each(keys)("the review route refuses %s", async (_label, key) => {
    expectRefused(
      await request(gui, REVIEW, {
        method: "POST",
        headers: { origin: gui.url, "content-type": "application/json" },
        body: {},
        token: resolve(key.token) as string | false,
      }),
    );
  });

  it("serves every /api route with the key, and an unknown /api route is then 404", async () => {
    for (const route of API_GET_ROUTES) {
      expect((await request(gui, route)).status, route).toBe(200);
    }
    expect((await request(gui, "/api/nothing-here")).status).toBe(404);
  });

  it("serves the page itself without the key, so it can read the key from its address", async () => {
    for (const route of PAGE_ROUTES) {
      const response = await request(gui, route, { token: false });
      expect(response.status, route).toBe(200);
      expect(response.text).not.toContain(gui.token);
    }
  });
});

describe("methods", () => {
  it.each(
    [...PAGE_ROUTES, ...API_GET_ROUTES, REVIEW].flatMap((route) =>
      ["PUT", "DELETE", "PATCH", "OPTIONS"].map((method) => [route, method]),
    ),
  )("%s answers %s with 405", async (route, method) => {
    const response = await request(gui, route as string, {
      method: method as string,
      headers: { origin: gui.url },
    });
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe("GET, HEAD");
  });

  it.each([...PAGE_ROUTES, ...API_GET_ROUTES])("%s answers POST with 405", async (route) => {
    const response = await request(gui, route, {
      method: "POST",
      headers: { origin: gui.url, "content-type": "application/json" },
      body: {},
    });
    expect(response.status).toBe(405);
  });

  it("answers HEAD with the full length and no body", async () => {
    for (const route of ["/", "/api/library", "/api/subagents/export.zip"]) {
      const get = await request(gui, route);
      const head = await request(gui, route, { method: "HEAD" });
      expect(head.status, route).toBe(200);
      expect(head.body.byteLength).toBe(0);
      expect(Number(head.headers["content-length"])).toBe(get.body.byteLength);
    }
  });
});

describe("browser headers", () => {
  it("keeps the same Content-Security-Policy and protective headers on every answer", async () => {
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    for (const response of [
      await request(gui, "/"),
      await request(gui, "/api/library"),
      await request(gui, "/api/library", { token: false }),
      await request(gui, "/", { headers: { host: "unrelated.example" } }),
    ]) {
      expect(response.headers["content-security-policy"]).toBe(
        SECURITY_HEADERS["Content-Security-Policy"],
      );
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
    }
  });
});

describe("the page's request code", () => {
  it("sends the key as a header on every request and never in a request line", async () => {
    const { fetchImpl, sent } = harnessFetch(gui);
    const client = sessionApi(gui.token, fetchImpl);
    for (const route of [
      "/api/library",
      "/api/highlights",
      "/api/preferences/generalized",
      "/api/subagents",
    ]) {
      await client.json(route);
    }
    const zip = await client.send("/api/subagents/export.zip?target=codex");
    expect(zip.status).toBe(200);
    expect(sent.length).toBe(5);
    for (const { url, headers } of sent) {
      expect(headers.get(SESSION_HEADER)).toBe(gui.token);
      expect(url).not.toContain(gui.token);
    }
    // What the server saw in its request lines.
    const lines = gui.requests.slice(-5);
    expect(lines).toEqual(sent.map(({ url }) => url));
    for (const line of lines) expect(line).not.toContain(gui.token);
  });

  it("reports a refused key as a session problem, not as missing data", async () => {
    const { fetchImpl } = harnessFetch(gui);
    const error = await sessionApi("f".repeat(64), fetchImpl)
      .json("/api/library")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionError);
    expect((error as SessionError).refused).toBe(true);
    const missing = await sessionApi(gui.token, fetchImpl)
      .json("/api/nothing-here")
      .catch((caught: unknown) => caught);
    expect((missing as SessionError).refused).toBe(false);
  });
});

describe("the first authenticated request", () => {
  it("is reported once, and never for the page, a wrong key, or a refused origin", async () => {
    let calls = 0;
    const handle = createGuiHandler({
      home: home.dir,
      token: gui.token,
      hosts: new Set([gui.host]),
      onAuthenticated: () => calls++,
    });
    const watched: Harness = { ...gui, handle, requests: [] };
    await request(watched, "/");
    await request(watched, "/app.js");
    await request(watched, "/api/library", { token: false });
    await request(watched, "/api/library", { token: nearMiss() });
    await request(watched, "/api/library", { headers: { origin: "https://unrelated.example" } });
    expect(calls).toBe(0);
    expect((await request(watched, "/api/library")).status).toBe(200);
    await request(watched, "/api/highlights");
    expect(calls).toBe(1);
  });
});

// The browser is opened on a local redirect file, so the page's first load is a
// navigation from a file: address, which browsers mark `sec-fetch-site:
// cross-site`. That one kind of request, a top-level page load of `/`, is
// served: it is what typing the address does, and the page carries no library
// data. Everything else from another site stays refused.
describe("a top-level page load from another site", () => {
  const navigation = {
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
  };
  it("serves the page shell, which holds no library text", async () => {
    const response = await request(gui, "/", { headers: navigation, token: false });
    expect(response.status).toBe(200);
    for (const text of PRIVATE_TEXT) expect(response.text).not.toContain(text);
  });

  it.each([
    ["an /api route", "/api/library", navigation],
    ["the script", "/app.js", navigation],
    ["a frame", "/", { ...navigation, "sec-fetch-dest": "iframe" }],
    ["a fetch", "/", { ...navigation, "sec-fetch-mode": "cors" }],
    ["a rebinding Host", "/", { ...navigation, host: "unrelated.example" }],
    ["a cross-site Origin", "/", { ...navigation, origin: "https://unrelated.example" }],
  ])("still refuses %s", async (_label, route, headers) => {
    expectRefused(await request(gui, route, { headers }));
  });
});

import { createGuiHandler, type GuiRequest } from "../src/gui/server.js";
import { SESSION_HEADER } from "../src/gui/session.js";

/**
 * test/gui-harness.ts: call the GUI request handler in process, with no socket.
 *
 * `guiHarness(home)` builds the same handler `startGuiServer` serves, for a
 * fixed synthetic port and key. `request()` sends one request; by default it
 * carries the right Host and the session key, and each option can remove or
 * replace them. Every request URL is recorded in `harness.requests`, so a test
 * can assert what a server would see in its request lines. `harnessFetch()`
 * adapts the handler to the `fetch` shape the page uses.
 */

const TEST_TOKEN = "0123456789abcdef".repeat(4);
const TEST_PORT = 43170;

export interface Harness {
  /** The base address, as `startGuiServer` reports it. */
  url: string;
  host: string;
  token: string;
  handle: ReturnType<typeof createGuiHandler>;
  /** Every request URL the handler received, in order. */
  requests: string[];
}

export function guiHarness(
  home: string,
  token = TEST_TOKEN,
  liveBatches?: Parameters<typeof createGuiHandler>[0]["liveBatches"],
): Harness {
  const host = `127.0.0.1:${TEST_PORT}`;
  const hosts = new Set([host, `localhost:${TEST_PORT}`]);
  return {
    url: `http://${host}`,
    host,
    token,
    handle: createGuiHandler({ home, token, hosts, liveBatches }),
    requests: [],
  };
}

export interface HarnessResponse {
  status: number;
  text: string;
  body: Buffer;
  /** Lowercased header names, like Node's `IncomingMessage.headers`. */
  headers: Record<string, string>;
}

export async function request(
  harness: Harness,
  route: string,
  opts: {
    method?: string;
    /** Extra or replacement headers; `undefined` removes a default one. */
    headers?: Record<string, string | undefined>;
    body?: unknown;
    /** `false` sends no session key; a string sends that key instead. */
    token?: string | false;
  } = {},
): Promise<HarnessResponse> {
  const headers: Record<string, string | undefined> = { host: harness.host };
  if (opts.token !== false) headers[SESSION_HEADER] = opts.token ?? harness.token;
  for (const [name, value] of Object.entries(opts.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  harness.requests.push(route);
  const body =
    opts.body === undefined
      ? ""
      : typeof opts.body === "string"
        ? opts.body
        : JSON.stringify(opts.body);
  const req: GuiRequest = {
    method: opts.method ?? "GET",
    url: route,
    headers,
    body: async () => (Buffer.byteLength(body) > 16_384 ? null : body),
  };
  const response = await harness.handle(req);
  const buffer = Buffer.from(response.body);
  return {
    status: response.status,
    text: buffer.toString("utf8"),
    body: buffer,
    headers: Object.fromEntries(
      Object.entries(response.headers).map(([name, value]) => [name.toLowerCase(), String(value)]),
    ),
  };
}

/** A `fetch` for the page's own request code, answered by the handler. */
export function harnessFetch(harness: Harness) {
  const sent: { url: string; headers: Headers }[] = [];
  const fetchImpl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    sent.push({ url: input, headers });
    const response = await request(harness, input, {
      method: init.method ?? "GET",
      token: false,
      headers: Object.fromEntries(headers.entries()),
      ...(typeof init.body === "string" ? { body: init.body } : {}),
    });
    const body = init.method === "HEAD" ? null : new Uint8Array(response.body);
    return new Response(body, {
      status: response.status,
      headers: response.headers,
    });
  };
  return { fetchImpl, sent };
}

/** Parse the JSON body of a 200 response. */
export async function getJson<T>(harness: Harness, route: string): Promise<T> {
  const response = await request(harness, route);
  if (response.status !== 200) throw new Error(`${route}: ${response.status} ${response.text}`);
  return JSON.parse(response.text) as T;
}

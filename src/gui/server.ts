import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http, { type Server } from "node:http";
import path from "node:path";
import { z } from "zod";
import {
  CONSOLIDATED_PREFERENCES_FILE,
  preferencesFingerprint,
  readConsolidatedPreferences,
} from "../core/consolidated-preferences.js";
import { domainPath } from "../core/domains.js";
import { GENERALIZED_PATH } from "../core/generalized.js";
import {
  fromEarlierGrouping,
  isOutcomeVerified,
  oneshotHash,
  parseOneshot,
  readLibrary,
} from "../core/library.js";
import {
  PREFERENCE_REVIEW_FILE,
  preferenceReview,
  readPreferenceReviews,
  reviewedPreferences,
  savePreferenceReview,
} from "../core/preference-review.js";
import {
  preferenceId,
  readObservedPreferences,
  renderPreferencesBlock,
} from "../core/preferences.js";
import {
  readSuggestion,
  type SuggestionArtifact,
  SuggestionReadError,
  suggestionPath,
} from "../core/subagents.js";
import {
  renderSubagentTree,
  SUBAGENT_TARGETS,
  type SubagentTarget,
} from "../core/subagents-render.js";
import { zipStore } from "../core/zip.js";
import { loadTasks } from "../distill/checkpoints.js";
import { acquireWriterLock, WriterBusyError } from "../distill/operations.js";
import { GUI_CSS, GUI_HTML, GUI_JS } from "./assets.js";
import { readHighlights, savedAgreements } from "./highlights.js";
import type { LiveBatches } from "./live-batches.js";
import { SESSION_HEADER } from "./session.js";
import { exportFilename } from "./subagents-view.js";

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
  /** False when no session behind the prompt reached a result that could be verified. */
  outcomeVerified: boolean;
  preferenceIds: string[];
  /** Left behind when sessions were regrouped: kept on disk, removed by `prune`. */
  earlier: boolean;
}

export interface GuiPreference {
  id: string;
  text: string;
  count: number;
  domains: string[];
  lastAuthoredAt: string;
  scope: "global" | "project" | "task";
  project?: string;
  basis?: "explicit" | "inferred";
  verified: boolean;
  review: ReturnType<typeof preferenceReview>;
  occurrences: {
    slug: string;
    title: string;
    evidence: string;
    available: boolean;
    exportName?: string;
    messageId?: string;
    quote?: string;
    timestamp?: string;
  }[];
}

export interface GuiSnapshot {
  entries: GuiEntry[];
  preferences: GuiPreference[];
  preferencesMarkdown: string;
  acceptedMarkdown: string;
  projectInstructions: { project: string; markdown: string }[];
  acceptedCount: number;
  reviewToken: string;
  reviewsInvalid: boolean;
  consolidation: {
    markdown: string;
    texts: string[];
    generatedAt: string;
    sourcePreferenceIds: string[];
    items: { text: string; sourceIds: string[] }[];
    stale: boolean;
    reviewed: boolean;
  } | null;
  consolidationInvalid: boolean;
  /** `start` is the bare command: the guided first run. */
  /** `gui` reopens this library after a restart. */
  commands: Record<
    "start" | "gui" | "preferences" | "consolidate" | "export" | "reflect" | "status",
    string
  >;
  skipped: number;
}

/**
 * The Suggested subagents tab. `files` is `renderSubagentTree(suggestion, { target: "all" })`
 * as a plain object: the same bytes Export all zips, rendered once on the
 * server so the browser bundle does not carry a second copy of the renderer.
 */
export interface GuiSubagents {
  suggestion: SuggestionArtifact | null;
  stale: boolean;
  error?: string;
  command: string;
  files: Record<string, string>;
}

export type { GuiAgreements } from "./highlights.js";

/** Check publication metadata without rereading prompts, transcripts or JSON contents. */
function libraryRevision(home: string): string {
  const library = path.join(home, "library");
  const files = [
    path.join(home, GENERALIZED_PATH),
    path.join(library, PREFERENCE_REVIEW_FILE),
    path.join(library, CONSOLIDATED_PREFERENCES_FILE),
    suggestionPath(home),
    ...[
      "distill/digests.json",
      "distill/tasks.json",
      "exports/manifest.json",
      "exports/outcomes.json",
    ].map((name) => path.join(home, name)),
  ];
  try {
    for (const entry of fs.readdirSync(library, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(library, entry.name);
      files.push(path.join(dir, "sources.json"), path.join(dir, `${entry.name}.oneshot.md`));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    const stat = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
    if (stat) hash.update(JSON.stringify([file, `${stat.ino}`, `${stat.ctimeNs}`, `${stat.size}`]));
  }
  return hash.digest("hex");
}

/** Copyable shell text for this home, never executed by the browser or server. */
function commandFor(home: string) {
  const homeArg = `'${path.resolve(home).replaceAll("'", "'\\''")}'`;
  return (name: string, flags = "") =>
    `npx human-hindsight@latest ${name ? `${name}${flags} ` : ""}--home ${homeArg}`;
}

/**
 * Read the saved suggestion with the same preference and review reads the
 * Preferences tab uses, so `stale` agrees with what that tab shows. A damaged
 * file is reported, never treated as absent and never rewritten.
 */
function subagentsSnapshot(home: string): GuiSubagents {
  const command = commandFor(home)("suggest-subagents");
  try {
    const saved = readSuggestion(home);
    if (!saved) return { suggestion: null, stale: false, command, files: {} };
    return {
      suggestion: saved.artifact,
      stale: saved.stale,
      command,
      files: Object.fromEntries(renderSubagentTree(saved.artifact, { target: "all" })),
    };
  } catch (error) {
    if (!(error instanceof SuggestionReadError)) throw error;
    return { suggestion: null, stale: false, error: error.reason, command, files: {} };
  }
}

/**
 * The only accepted query is one `target` from a fixed list; it selects a
 * renderer option and never names a file. Anything else is refused.
 */
function exportTarget(url: string | undefined): SubagentTarget | "all" | null {
  let query: URLSearchParams;
  try {
    query = new URL(url ?? "/", "http://127.0.0.1").searchParams;
  } catch {
    return null;
  }
  if ([...query.keys()].some((key) => key !== "target") || query.getAll("target").length > 1)
    return null;
  const target = query.get("target") ?? "all";
  if (target === "all") return "all";
  return SUBAGENT_TARGETS.find((known) => known === target) ?? null;
}

/** Canonical path separators and case-insensitive identity, preserving readable labels. */
function normalizedDomains(values: string[]): string[] {
  const paths = new Map<string, string>();
  for (const value of values) {
    const normalized = domainPath(value).join(" > ");
    if (normalized && !paths.has(normalized.toLowerCase())) {
      paths.set(normalized.toLowerCase(), normalized);
    }
  }
  return [...paths.values()].sort((a, b) => a.localeCompare(b));
}

/** Expose browsing data and commands for this home, without raw transcripts or source paths. */
function librarySnapshot(home: string, reviewToken: string): GuiSnapshot {
  const library = readLibrary(home);
  const sources = new Map(library.map((entry) => [entry.slug, entry.sources]));
  const grouping = loadTasks(home);
  const entries: GuiEntry[] = [];
  let skipped = 0;
  for (const entry of library) {
    try {
      const content = fs.readFileSync(entry.oneshotPath, "utf8");
      const { title, body } = parseOneshot(content);
      const source = entry.sources;
      const edited = Boolean(source.oneshot_hash && source.oneshot_hash !== oneshotHash(content));
      entries.push({
        slug: entry.slug,
        title: title || source.title || entry.slug,
        body,
        domains: source.domains,
        authoredAt: source.authored_at,
        sessions: source.members.length,
        confidence: source.confidence,
        rating: source.rating ?? null,
        edited,
        outcomeVerified: isOutcomeVerified(source),
        preferenceIds: [],
        earlier: fromEarlierGrouping(entry, grouping, { edited }),
      });
    } catch {
      skipped++;
    }
  }
  const prompts = new Map(entries.map((entry) => [entry.slug, entry]));
  const aggregated = readObservedPreferences(home);
  const reviewState = readPreferenceReviews(home);
  const preferences = aggregated.map((preference): GuiPreference => {
    const id = preferenceId(preference);
    // A grouped prompt can span unrelated sessions. Its full domain union must
    // not become evidence for each individual preference associated with it.
    const evidenceDomains = normalizedDomains(
      preference.occurrences.flatMap((occurrence) => occurrence.domains ?? []),
    );
    const ownDomains = normalizedDomains(preference.domains ?? []);
    const domains =
      evidenceDomains.length > 0
        ? evidenceDomains
        : ownDomains.length > 0
          ? ownDomains
          : normalizedDomains(
              preference.occurrences.flatMap(({ slug }) => sources.get(slug)?.domains ?? []),
            );
    const occurrences = preference.occurrences.map((occurrence) => {
      const { slug, evidence } = occurrence;
      const prompt = prompts.get(slug);
      const source = sources.get(slug);
      prompt?.preferenceIds.push(id);
      return {
        slug,
        title: prompt?.title || source?.title || occurrence.exportName || slug,
        evidence,
        available: Boolean(prompt),
        ...(occurrence.exportName ? { exportName: occurrence.exportName } : {}),
        ...(occurrence.messageId ? { messageId: occurrence.messageId } : {}),
        ...(occurrence.quote ? { quote: occurrence.quote } : {}),
        ...(occurrence.timestamp ? { timestamp: occurrence.timestamp } : {}),
      };
    });
    return {
      id,
      text: preference.text,
      count: preference.count,
      domains,
      lastAuthoredAt: preference.lastAuthoredAt,
      scope: preference.scope ?? "global",
      project: preference.project,
      basis: preference.basis,
      verified: preference.verified === true,
      review: preferenceReview(home, preference, reviewState.reviews),
      occurrences,
    };
  });
  const accepted = reviewedPreferences(home, aggregated);
  const projects = [
    ...new Set(
      preferences
        .filter((preference) => preference.review.status === "accepted")
        .map((preference) => preference.review.project)
        .filter((project): project is string => Boolean(project)),
    ),
  ].sort();
  const instructions = (project?: string) => {
    const selected = project ? reviewedPreferences(home, aggregated, project) : accepted;
    return selected.length ? renderPreferencesBlock(selected, library.length, "agents") : "";
  };
  const { artifact, invalid } = readConsolidatedPreferences(home);
  const consolidationInputs = artifact?.include_unreviewed
    ? aggregated.filter(
        (preference) =>
          (preference.scope ?? "global") === "global" ||
          (preference.scope === "project" &&
            Boolean(artifact.project) &&
            preference.project === artifact.project),
      )
    : reviewedPreferences(home, aggregated, artifact?.project);
  const legacyFingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        aggregated
          .map(({ text, count }) => ({ text, count }))
          .sort((a, b) => a.text.localeCompare(b.text) || a.count - b.count),
      ),
    )
    .digest("hex");
  const consolidationStale = Boolean(
    artifact &&
      artifact.source_hash !==
        (artifact.version === 1 ? legacyFingerprint : preferencesFingerprint(consolidationInputs)),
  );
  const command = commandFor(home);
  return {
    entries,
    preferences,
    preferencesMarkdown: aggregated.length
      ? renderPreferencesBlock(aggregated, library.length)
      : "",
    acceptedMarkdown: instructions(),
    projectInstructions: projects.map((project) => ({ project, markdown: instructions(project) })),
    acceptedCount: preferences.filter((preference) => preference.review.status === "accepted")
      .length,
    reviewToken,
    reviewsInvalid: reviewState.invalid,
    consolidation: artifact
      ? {
          markdown: artifact.markdown,
          texts: artifact.preferences.map((preference) => preference.text),
          generatedAt: artifact.generated_at,
          sourcePreferenceIds: artifact.source_preferences.map((preference) =>
            preferenceId({
              ...preference,
              occurrences: [],
              lastAuthoredAt: "",
            }),
          ),
          items: artifact.preferences.map((preference) => ({
            text: preference.text,
            sourceIds: preference.source_ids ?? [],
          })),
          stale: consolidationStale,
          reviewed: artifact.version === 2 && !artifact.include_unreviewed,
        }
      : null,
    consolidationInvalid: invalid,
    commands: {
      start: command(""),
      gui: command("gui"),
      preferences: command("preferences"),
      consolidate: command("preferences", " --consolidate"),
      export: command("export"),
      reflect: command("reflect"),
      status: command("status"),
    },
    skipped,
  };
}

export interface GuiServer {
  server: Server;
  /** The base address, without the session fragment. */
  url: string;
  /** The session key every `/api` request must send in {@link SESSION_HEADER}. */
  token: string;
  close(): Promise<void>;
}

/** One request as the handler sees it, independent of the HTTP server. */
export interface GuiRequest {
  method: string;
  url: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The request body, or null when it exceeds the limit. Read only after every check passed. */
  body(): Promise<string | null>;
}

export interface GuiResponse {
  status: number;
  headers: Record<string, string | number>;
  /** Empty for HEAD; `Content-Length` still describes the full body. */
  body: string | Uint8Array;
}

/** Sent on every response, including refusals. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-DNS-Prefetch-Control": "off",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const REVIEW_BODY_LIMIT = 16_384;
const JSON_TYPE = "application/json; charset=utf-8";
const TEXT_TYPE = "text/plain; charset=utf-8";
const ORIGIN_REFUSED = "This library is available only from its local browser address.";
const SESSION_REFUSED =
  "This library needs the address printed in your terminal. Open that address again.";

function header(req: GuiRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Constant-time comparison, so response timing does not reveal the key. */
function sameToken(given: string | undefined, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The whole request policy, in one place and without a socket:
 * 1. Host, Origin, and `sec-fetch-site` checks on every route (DNS rebinding
 *    and cross-site requests);
 * 2. the session key on every `/api` route, from the header only;
 * 3. one same-origin JSON POST for preference reviews, everything else GET or HEAD;
 * 4. a fixed route table, never a URL-to-filesystem mapping.
 */
export function createGuiHandler(opts: {
  home: string;
  token: string;
  hosts: ReadonlySet<string>;
  liveBatches?: LiveBatches;
  /** Called once, on the first request that carried the session key. */
  onAuthenticated?: () => void;
  /** Stop this view: the next reflection on this machine takes its port over. */
  onShutdown?: () => void;
}): (req: GuiRequest) => Promise<GuiResponse> {
  const { home, token } = opts;
  let authenticated = false;
  return async (req) => {
    const head = req.method === "HEAD";
    const reply = (
      status: number,
      body: string | Uint8Array,
      type = TEXT_TYPE,
      extra: Record<string, string | number> = {},
    ): GuiResponse => ({
      status,
      headers: {
        ...SECURITY_HEADERS,
        "Content-Type": type,
        "Content-Length": typeof body === "string" ? Buffer.byteLength(body) : body.byteLength,
        ...extra,
      },
      body: head ? "" : body,
    });
    const json = (value: unknown) => reply(200, JSON.stringify(value), JSON_TYPE);
    const host = header(req, "host") ?? "";
    const origin = header(req, "origin");
    const route = req.url.split("?")[0] ?? "";
    // `gui` opens the browser on a local redirect file (the key stays off
    // process arguments), and browsers mark a navigation from a file: address
    // as cross-site. A top-level load of the page shell is served anyway: it
    // is what typing the address does, and the shell holds no library data.
    const pageLoad =
      route === "/" &&
      (req.method === "GET" || head) &&
      header(req, "sec-fetch-mode") === "navigate" &&
      header(req, "sec-fetch-dest") === "document";
    // Loopback binding alone does not stop DNS rebinding or cross-site requests.
    // Never grant CORS access or accept a Host supplied by an unrelated website.
    if (
      !opts.hosts.has(host) ||
      (origin && origin !== `http://${host}`) ||
      (header(req, "sec-fetch-site") === "cross-site" && !pageLoad)
    ) {
      return reply(403, ORIGIN_REFUSED);
    }
    if (route === "/api" || route.startsWith("/api/")) {
      if (!sameToken(header(req, SESSION_HEADER), token)) return reply(403, SESSION_REFUSED);
      if (!authenticated) {
        authenticated = true;
        opts.onAuthenticated?.();
      }
    }
    if (route === "/api/preferences/review" && req.method === "POST") {
      if (
        origin !== `http://${host}` ||
        header(req, "content-type")?.split(";")[0]?.trim() !== "application/json"
      ) {
        return reply(403, "Preference reviews require this library's browser session.");
      }
      let body: string | null;
      try {
        body = await req.body();
      } catch {
        return reply(400, "Could not read the preference review.");
      }
      if (body === null) return reply(413, "Preference review is too large.");
      try {
        const update = ReviewRequestSchema.parse(JSON.parse(body));
        const preference = readObservedPreferences(home).find(
          (candidate) => preferenceId(candidate) === update.id,
        );
        if (!preference) {
          return reply(
            404,
            "This preference is no longer available. Choose Refresh to load the current library.",
          );
        }
        if (preferenceReview(home, preference).revision !== update.revision) {
          return reply(
            409,
            "This preference changed. Choose Refresh and review its current evidence.",
          );
        }
        // A review changes the library, so it takes the writer lock every
        // other writer takes. While a command holds it, nothing is saved and
        // the reply names that command.
        let writer: ReturnType<typeof acquireWriterLock>;
        try {
          writer = acquireWriterLock(home, "gui");
        } catch (error) {
          if (error instanceof WriterBusyError) return reply(423, error.message);
          throw error;
        }
        try {
          savePreferenceReview(home, preference, update, update.revision);
        } finally {
          writer.release();
        }
        return json(librarySnapshot(home, token));
      } catch (error) {
        return reply(
          400,
          error instanceof z.ZodError || error instanceof SyntaxError
            ? "Invalid preference review."
            : "Could not save this review. Choose Refresh and check the selected scope.",
        );
      }
    }
    // Only the view a reflection started takes this, and only with its session key.
    if (route === "/api/shutdown" && req.method === "POST" && opts.onShutdown) {
      // Still in use: its reflection is running and its link is on screen.
      if (opts.liveBatches?.isRunning())
        return reply(409, "This view's reflection is still running.", TEXT_TYPE);
      setImmediate(opts.onShutdown);
      return reply(204, "");
    }
    if (req.method !== "GET" && !head) {
      return reply(405, "Read-only library.", TEXT_TYPE, { Allow: "GET, HEAD" });
    }
    const failed = (message: string) => reply(500, JSON.stringify({ error: message }), JSON_TYPE);
    switch (route) {
      case "/":
        return reply(200, GUI_HTML, "text/html; charset=utf-8");
      case "/app.css":
        return reply(200, GUI_CSS, "text/css; charset=utf-8");
      case "/app.js":
        return reply(200, GUI_JS, "text/javascript; charset=utf-8");
      case "/api/library/revision":
        try {
          return json({ revision: `${libraryRevision(home)}-${opts.liveBatches?.revision ?? 0}` });
        } catch {
          return failed("Could not check for library updates.");
        }
      case "/api/library":
        try {
          return json(librarySnapshot(home, token));
        } catch {
          return failed("Could not read the library.");
        }
      case "/api/highlights":
        try {
          return json(readHighlights(home));
        } catch {
          return failed("Could not read the library highlights.");
        }
      case "/api/preferences/generalized":
        try {
          return json({
            ...savedAgreements(home),
            live: opts.liveBatches?.snapshot(),
            running: opts.liveBatches?.isRunning(),
          });
        } catch {
          return failed("Could not read the saved preferences.");
        }
      case "/api/subagents":
        try {
          return json(subagentsSnapshot(home));
        } catch {
          return failed("Could not read the suggested subagents.");
        }
      case "/api/subagents/export.zip": {
        // Built in memory from the saved suggestion; nothing is written.
        const target = exportTarget(req.url);
        if (!target) {
          return reply(
            400,
            `Unknown export target. Use one of: all, ${SUBAGENT_TARGETS.join(", ")}.`,
          );
        }
        let saved: ReturnType<typeof readSuggestion>;
        try {
          saved = readSuggestion(home);
        } catch (error) {
          return reply(
            500,
            error instanceof SuggestionReadError
              ? error.message
              : "Could not read the suggested subagents.",
          );
        }
        if (!saved) {
          return reply(
            404,
            "No suggested subagents yet. Run suggest-subagents, then choose Refresh.",
          );
        }
        const { artifact } = saved;
        const zip = zipStore(renderSubagentTree(artifact, { target }), {
          mtime: new Date(artifact.generated_at),
        });
        return reply(200, zip, "application/zip", {
          "Content-Disposition": `attachment; filename="${exportFilename(artifact.generated_at, target)}"`,
        });
      }
      default:
        return reply(404, "Not found.");
    }
  };
}

/** The whole body as text, or null once it passes `limit` bytes (the rest is drained). */
async function readLimitedBody(
  stream: AsyncIterable<Buffer | string>,
  limit: number,
): Promise<string | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    bytes += buffer.byteLength;
    if (bytes <= limit) chunks.push(buffer);
  }
  return bytes > limit ? null : Buffer.concat(chunks).toString("utf8");
}

const ReviewRequestSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["pending", "accepted", "dismissed"]),
    text: z.string().trim().min(1).max(8000).optional(),
    scope: z.enum(["global", "project", "task"]).optional(),
    project: z.string().trim().max(2000).optional(),
  })
  .strict();

/** A loopback server around {@link createGuiHandler}. */
export async function startGuiServer(opts: {
  home: string;
  port?: number;
  token?: string;
  liveBatches?: LiveBatches;
  /** Called once, on the first request that carried the session key. */
  onAuthenticated?: () => void;
  /** Let a later view on this machine ask this one to stop and free its port. */
  handoff?: boolean;
}): Promise<GuiServer> {
  const port = opts.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("--port must be an integer between 0 and 65535 (0 chooses an available port).");
  }
  const hosts = new Set<string>();
  const token = opts.token ?? randomBytes(32).toString("hex");
  const handle = createGuiHandler({
    home: opts.home,
    token,
    hosts,
    onAuthenticated: opts.onAuthenticated,
    liveBatches: opts.liveBatches,
    ...(opts.handoff && { onShutdown: () => stop() }),
  });
  let stop = () => {};
  const server = http.createServer(
    { requestTimeout: 10_000, headersTimeout: 10_000 },
    (req, res) => {
      let body: Promise<string | null> | undefined;
      handle({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body: () => {
          body ??= readLimitedBody(req, REVIEW_BODY_LIMIT);
          return body;
        },
      })
        .then((response) => {
          res.writeHead(response.status, response.headers);
          res.end(response.body);
        })
        .catch(() => {
          if (!res.headersSent)
            res.writeHead(500, { ...SECURITY_HEADERS, "Content-Type": TEXT_TYPE });
          res.end("The library could not answer this request.");
        });
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
  const gui: GuiServer = {
    server,
    url: `http://127.0.0.1:${address.port}`,
    token,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      });
      return closing;
    },
  };
  stop = () => void gui.close().catch(() => {});
  return gui;
}

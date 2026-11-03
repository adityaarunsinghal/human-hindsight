import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http, { type Server } from "node:http";
import path from "node:path";
import { z } from "zod";
import {
  preferencesFingerprint,
  readConsolidatedPreferences,
} from "../core/consolidated-preferences.js";
import { oneshotHash, parseOneshot, readLibrary } from "../core/library.js";
import {
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
  preferenceIds: string[];
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
  commands: Record<"preferences" | "consolidate" | "export" | "distill" | "status", string>;
  skipped: number;
}

/** Expose browsing data and commands for this home, without raw transcripts or source paths. */
function librarySnapshot(home: string, reviewToken: string): GuiSnapshot {
  const library = readLibrary(home);
  const sources = new Map(library.map((entry) => [entry.slug, entry.sources]));
  const entries: GuiEntry[] = [];
  let skipped = 0;
  for (const entry of library) {
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
        preferenceIds: [],
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
    const domains = new Set<string>(preference.domains ?? []);
    const occurrences = preference.occurrences.map((occurrence) => {
      const { slug, evidence } = occurrence;
      const prompt = prompts.get(slug);
      const source = sources.get(slug);
      prompt?.preferenceIds.push(id);
      for (const domain of source?.domains ?? []) domains.add(domain);
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
      domains: [...domains].sort((a, b) => a.localeCompare(b)),
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
  // Commands are copyable shell text, never executed by the browser or server.
  const homeArg = `'${path.resolve(home).replaceAll("'", "'\\''")}'`;
  const command = (name: string, flags = "") =>
    `npx human-hindsight@latest ${name}${flags} --home ${homeArg}`;
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
      preferences: command("preferences"),
      consolidate: command("preferences", " --consolidate"),
      export: command("export"),
      distill: command("distill"),
      status: command("status"),
    },
    skipped,
  };
}

export interface GuiServer {
  server: Server;
  url: string;
  close(): Promise<void>;
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

/** Fixed library routes and one authenticated, local preference-review action. */
export async function startGuiServer(opts: { home: string; port?: number }): Promise<GuiServer> {
  const port = opts.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("--port must be an integer between 0 and 65535 (0 chooses an available port).");
  }
  const hosts = new Set<string>();
  const reviewToken = randomBytes(32).toString("hex");
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
      const route = req.url?.split("?")[0];
      if (route === "/api/preferences/review" && req.method === "POST") {
        if (
          req.headers.origin !== `http://${req.headers.host}` ||
          req.headers["x-hindsight-token"] !== reviewToken ||
          req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json"
        ) {
          send(403, "Preference reviews require this library's browser session.");
          return;
        }
        let body = "";
        let bytes = 0;
        let rejected = false;
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 16_384) {
            if (!rejected) send(413, "Preference review is too large.");
            rejected = true;
            body = "";
          } else if (!rejected) body += chunk;
        });
        req.on("end", () => {
          if (rejected) return;
          try {
            const update = ReviewRequestSchema.parse(JSON.parse(body));
            const preference = readObservedPreferences(opts.home).find(
              (candidate) => preferenceId(candidate) === update.id,
            );
            if (!preference) {
              send(404, "This preference is no longer available. Refresh the library.");
              return;
            }
            if (preferenceReview(opts.home, preference).revision !== update.revision) {
              send(409, "This preference changed. Refresh and review its current evidence.");
              return;
            }
            savePreferenceReview(opts.home, preference, update, update.revision);
            send(
              200,
              JSON.stringify(librarySnapshot(opts.home, reviewToken)),
              "application/json; charset=utf-8",
            );
          } catch (error) {
            send(
              400,
              error instanceof z.ZodError || error instanceof SyntaxError
                ? "Invalid preference review."
                : "Could not save this review. Refresh and check the selected scope.",
            );
          }
        });
        req.on("error", () => {
          if (!res.writableEnded) send(400, "Could not read the preference review.");
        });
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.setHeader("Allow", "GET, HEAD");
        send(405, "Read-only library.");
        return;
      }
      // A fixed route table, never a URL-to-filesystem mapping.
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
              JSON.stringify(librarySnapshot(opts.home, reviewToken)),
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

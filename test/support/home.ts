import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ManifestEntry } from "../../src/commands/export.js";
import { isShortTurn } from "../../src/core/anaphora.js";
import {
  contentFingerprint,
  digestSourceFingerprint,
  fingerprint,
} from "../../src/core/fingerprint.js";
import { oneshotHash } from "../../src/core/library.js";
import { OUTCOME_NOTE, type OutcomeEvidence } from "../../src/core/outcome.js";
import {
  PREFERENCE_REVIEW_FILE,
  type PreferenceReviews,
  preferenceRevision,
} from "../../src/core/preference-review.js";
import { preferenceId, readObservedPreferences } from "../../src/core/preferences.js";
import { exportFileName } from "../../src/core/render.js";
import {
  computeCoverage,
  type Lesson,
  type Role,
  SUGGEST_PROMPT_VERSIONS,
  type SuggestionArtifact,
  selectSuggestionInputs,
  suggestionFingerprint,
  writeSuggestion,
} from "../../src/core/subagents.js";
import type { DigestLineage } from "../../src/distill/checkpoints.js";
import { AUTHOR_PROMPT_VERSION } from "../../src/distill/prompts/author.js";
import { CLUSTER_PROMPT_VERSION } from "../../src/distill/prompts/cluster.js";
import { DIGEST_PROMPT_VERSION } from "../../src/distill/prompts/digest.js";
import type { Digest, PreferenceCandidate } from "../../src/distill/schemas.js";
import type { SourceName } from "../../src/sources/types.js";

/**
 * test/support/home.ts: build a synthetic data home in a temporary folder.
 *
 * Every artifact is written in the shape its real writer produces, using the
 * project's own helpers for names and hashes, so the project's readers accept
 * it (`readLibrary`, `loadDigests`, `loadTasks`, `readObservedPreferences`,
 * `readPreferenceReviews`, `readSuggestion`). All text is synthetic.
 *
 *   const home = homeBuilder()
 *     .session({ project: "alpha", sessionId: "a1111111-0000-4000-8000-000000000001",
 *                messages: ["Please keep the change small and run the tests."] })
 *     .digest(0, { preferences: [{ text: "Keep changes small.", quote: "keep the change small" }] })
 *     .task({ slug: "small-change", members: [0] })
 *     .library("small-change")
 *     .review("Keep changes small.", "accepted")
 *     .suggestion()
 *     .build();
 *   home.dir;            // the data home, under the system temp folder
 *   home.exports[0];     // "alpha-a1111111.md"
 *   home.remove();       // delete it again
 *
 * What gets written (relative to the data home):
 *   exports/<name>.md, exports/manifest.json, exports/anaphora.json, exports/outcomes.json
 *   distill/digests.json (with lineage whose source hash matches the export), distill/tasks.json
 *   library/<slug>/<slug>.oneshot.md and library/<slug>/sources.json
 *   library/preferences.review.json
 *   library/subagents/suggestion.json (validated by the project's writer)
 *
 * Writing the review needs the observed preferences, so `build()` writes in
 * order: exports, digests, tasks, library, then reviews, then the suggestion.
 */

export const SAMPLE_GENERATION = "20260102T030405Z-0a1b";
const SAMPLE_START = "2026-01-02T03:04:05.000Z";
const SAMPLE_MODEL = "synthetic-model";
const SAMPLE_TOOL_VERSION = "0.0.0-test";

export interface SessionSpec {
  project: string;
  sessionId: string;
  /** Human messages, in order. Timestamps are one minute apart from `start`. */
  messages: string[];
  origin?: SourceName;
  start?: string;
  /** Where the transcript "came from"; synthetic by default. */
  source?: string;
  assistantTail?: string;
}

export interface PreferenceSpec {
  text: string;
  /** Verbatim text from one of the session's messages. */
  quote: string;
  /** Message index to cite; default is the first message containing the quote. */
  message?: number;
  scope?: "global" | "project" | "task";
  basis?: "explicit" | "inferred";
  evidence?: string;
}

export interface DigestSpec extends Partial<Omit<Digest, "preferences">> {
  preferences?: PreferenceSpec[];
}

export interface TaskSpec {
  slug: string;
  title?: string;
  rationale?: string;
  /** Export names or session indexes. */
  members: (string | number)[];
}

export interface LibrarySpec {
  title?: string;
  body?: string;
  confidence?: "high" | "medium" | "low";
}

export interface BuiltHome {
  /** The data home. */
  dir: string;
  /** Export file names, in the order sessions were added. */
  exports: string[];
  /** Absolute path of a file under the home. */
  path(relative: string): string;
  /** Read a file under the home as text. */
  read(relative: string): string;
  /** Read and parse a JSON file under the home. */
  json<T = unknown>(relative: string): T;
  /** Delete the home (only what this builder created). */
  remove(): void;
}

export interface HomeBuilder {
  session(spec: SessionSpec): HomeBuilder;
  digest(session: string | number, spec?: DigestSpec): HomeBuilder;
  /** Give every session without a digest the default digest. */
  digestAll(): HomeBuilder;
  task(spec: TaskSpec): HomeBuilder;
  misc(...members: (string | number)[]): HomeBuilder;
  library(slug: string, spec?: LibrarySpec): HomeBuilder;
  review(text: string, status: "accepted" | "dismissed", edit?: { text?: string }): HomeBuilder;
  suggestion(): HomeBuilder;
  /** Write everything into `dir`, or a new temporary folder. */
  build(dir?: string): BuiltHome;
}

export interface HomeBuilderOptions {
  generation?: string;
  /** Used for every written time (`authored_at`, `updated_at`, `generated_at`). */
  now?: () => Date;
}

const DEFAULT_BODY =
  "Review the synthetic build workflow, keep every change small and focused, explain each " +
  "material decision in plain words, and verify the result with the existing test suite " +
  "before reporting back.";

function minuteAfter(start: string, minutes: number): string {
  return new Date(new Date(start).getTime() + minutes * 60_000).toISOString();
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeJson(file: string, value: unknown): void {
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function homeBuilder(options: HomeBuilderOptions = {}): HomeBuilder {
  const generation = options.generation ?? SAMPLE_GENERATION;
  const now = options.now ?? (() => new Date(SAMPLE_START));
  const sessions: (SessionSpec & { exportName: string })[] = [];
  const used = new Set<string>();
  const digests = new Map<string, DigestSpec>();
  const tasks: TaskSpec[] = [];
  const misc: (string | number)[] = [];
  const library = new Map<string, LibrarySpec>();
  const reviews: { text: string; status: "accepted" | "dismissed"; edit?: { text?: string } }[] =
    [];
  let wantSuggestion = false;

  const exportOf = (ref: string | number): string => {
    if (typeof ref === "string") return ref;
    const session = sessions[ref];
    if (!session) throw new Error(`No session at index ${ref}`);
    return session.exportName;
  };

  const builder: HomeBuilder = {
    session(spec) {
      sessions.push({ ...spec, exportName: exportFileName(spec.project, spec.sessionId, used) });
      return builder;
    },
    digest(session, spec = {}) {
      digests.set(exportOf(session), spec);
      return builder;
    },
    digestAll() {
      for (const session of sessions) {
        if (!digests.has(session.exportName)) digests.set(session.exportName, {});
      }
      return builder;
    },
    task(spec) {
      tasks.push(spec);
      return builder;
    },
    misc(...members) {
      misc.push(...members);
      return builder;
    },
    library(slug, spec = {}) {
      library.set(slug, spec);
      return builder;
    },
    review(text, status, edit) {
      reviews.push({ text, status, edit });
      return builder;
    },
    suggestion() {
      wantSuggestion = true;
      return builder;
    },
    build(dir) {
      const home = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "hh-home-"));
      const owned = dir === undefined;
      try {
        return writeHome(home, owned);
      } catch (error) {
        // A refused build leaves nothing behind in the temp folder.
        if (owned) fs.rmSync(home, { recursive: true, force: true });
        throw error;
      }
    },
  };
  return builder;

  function writeHome(home: string, owned: boolean): BuiltHome {
    const rel = (relative: string) => path.join(home, relative);

    // Exports: markdown in the renderer's format, then the three indexes.
    const contents = new Map<string, string>();
    const manifest: ManifestEntry[] = [];
    const anaphora: Record<string, unknown[]> = {};
    const outcomes: Record<string, unknown> = { _note: OUTCOME_NOTE };
    for (const session of sessions) {
      const start = session.start ?? SAMPLE_START;
      const stamps = session.messages.map((_, index) => minuteAfter(start, index));
      const source = session.source ?? `/synthetic/${session.project}/${session.sessionId}.jsonl`;
      const content =
        `<!-- source: ${source}\n     messages: ${session.messages.length} -->\n` +
        session.messages.map((text, index) => `\n### ${stamps[index]}\n\n${text}\n`).join("");
      contents.set(session.exportName, content);
      writeFile(rel(`exports/${session.exportName}`), content);
      manifest.push({
        export: session.exportName,
        source,
        origin: session.origin ?? "claude",
        project: session.project,
        sessionId: session.sessionId,
        messages: session.messages.length,
        first_ts: stamps[0] ?? start,
        last_ts: stamps.at(-1) ?? start,
      });
      anaphora[session.exportName] = session.messages.flatMap((text, index) =>
        isShortTurn(text)
          ? [
              {
                index,
                timestamp: stamps[index],
                human_text: text,
                antecedent: null,
                decision_kind: null,
                decision_text: null,
              },
            ]
          : [],
      );
      const outcome: OutcomeEvidence = {
        final_human_turns: session.messages.slice(-3),
        final_assistant_tail: session.assistantTail ?? "The change is in place and tests pass.",
      };
      outcomes[session.exportName] = outcome;
    }
    if (sessions.length) {
      manifest.sort((a, b) => a.export.localeCompare(b.export));
      writeJson(rel("exports/manifest.json"), manifest);
      writeJson(
        rel("exports/anaphora.json"),
        Object.fromEntries(Object.entries(anaphora).sort(([a], [b]) => a.localeCompare(b))),
      );
      writeJson(rel("exports/outcomes.json"), outcomes);
    }

    // Digests, with lineage whose source hash matches the export as written.
    const byExport = new Map(manifest.map((entry) => [entry.export, entry]));
    const digestRecords: Record<string, Digest> = {};
    const lineage: Record<string, DigestLineage> = {};
    for (const [exportName, spec] of digests) {
      const entry = byExport.get(exportName);
      const content = contents.get(exportName);
      if (!entry || content === undefined) throw new Error(`Digest for unknown ${exportName}`);
      const messages = sessions.find((s) => s.exportName === exportName)?.messages ?? [];
      const preferences: PreferenceCandidate[] = (spec.preferences ?? []).map((pref) => {
        const index = pref.message ?? messages.findIndex((text) => text.includes(pref.quote));
        if (index < 0 || !messages[index]?.includes(pref.quote))
          throw new Error(`Quote "${pref.quote}" is not in ${exportName}`);
        return {
          text: pref.text,
          evidence: pref.evidence ?? pref.quote,
          scope: pref.scope ?? "global",
          basis: pref.basis ?? "explicit",
          citations: [{ message_id: `${exportName}#m${index}`, quote: pref.quote }],
        };
      });
      const { preferences: _ignored, ...fields } = spec;
      digestRecords[exportName] = {
        goal: `Improve the ${entry.project} build`,
        deliverable: "A reviewed patch",
        domain: "development",
        keywords: ["build", "tests"],
        outcome: "completed",
        ...fields,
        preferences,
      };
      const outcome = outcomes[exportName];
      lineage[exportName] = {
        version: 1,
        fingerprint: fingerprint({ synthetic: exportName }),
        prompt_version: DIGEST_PROMPT_VERSION,
        schema_hash: fingerprint("synthetic-digest-schema"),
        model: SAMPLE_MODEL,
        runner: "claude",
        project: entry.project,
        session_id: entry.sessionId,
        origin: entry.origin ?? "claude",
        observed_at: entry.last_ts,
        content_hash: contentFingerprint(content),
        source_hash: digestSourceFingerprint({
          content,
          outcome,
          project: entry.project,
          sessionId: entry.sessionId,
          origin: entry.origin,
        }),
      };
    }
    if (digests.size) {
      writeJson(rel("distill/digests.json"), {
        generation,
        prompt_version: DIGEST_PROMPT_VERSION,
        digests: digestRecords,
        lineage,
      });
    }

    // Tasks.
    const taskRecords = tasks.map((task) => ({
      slug: task.slug,
      title: task.title ?? `Improve ${task.slug.replace(/-/g, " ")}`,
      rationale: task.rationale ?? "These sessions share one goal.",
      members: task.members.map(exportOf),
    }));
    if (tasks.length || misc.length) {
      writeJson(rel("distill/tasks.json"), {
        generation,
        prompt_version: CLUSTER_PROMPT_VERSION,
        tasks: taskRecords,
        misc: misc.map(exportOf),
      });
    }

    // Library entries, shaped like the author stage's output.
    for (const [slug, spec] of library) {
      const task = taskRecords.find((candidate) => candidate.slug === slug);
      if (!task) throw new Error(`Library entry "${slug}" has no task`);
      const authoredAt = now().toISOString();
      const memberDigests = task.members.map((member) => digestRecords[member]);
      const sources: Record<string, unknown> = {
        slug,
        title: spec.title ?? task.title,
        members: task.members,
        sessionIds: task.members.map((member) => byExport.get(member)?.sessionId ?? "unknown"),
        preferences: task.members.flatMap((member) =>
          (digestRecords[member]?.preferences ?? []).map((candidate) => ({
            ...candidate,
            ...(candidate.scope === "global"
              ? {}
              : { project: byExport.get(member)?.project ?? "" }),
          })),
        ),
        outcome_summary: `${task.members.length} completed`,
        domains: [
          ...new Set(memberDigests.map((d) => d?.domain.trim().toLowerCase()).filter(Boolean)),
        ],
        confidence: spec.confidence ?? "high",
        authored_at: authoredAt,
        model: SAMPLE_MODEL,
        runner: "claude",
        prompt_version: AUTHOR_PROMPT_VERSION,
        tool_version: SAMPLE_TOOL_VERSION,
        generation,
        input_coverage: 1,
        truncations: [],
      };
      const title = String(sources.title);
      const provenance = [
        "<!--",
        `  generated by human-hindsight v${SAMPLE_TOOL_VERSION}`,
        `  task: ${slug} (generation ${generation})`,
        `  sources: ${task.members.join(", ")}`,
        `  outcomes: ${sources.outcome_summary}; confidence: ${sources.confidence}`,
        "  runner: claude",
        `  model: ${SAMPLE_MODEL}; prompt v${AUTHOR_PROMPT_VERSION}; ${authoredAt}`,
        "-->",
      ].join("\n");
      const oneshot = `${provenance}\n\n# ${title}\n\n${spec.body ?? DEFAULT_BODY}\n`;
      sources.oneshot_hash = oneshotHash(oneshot);
      writeFile(rel(`library/${slug}/${slug}.oneshot.md`), oneshot);
      writeJson(rel(`library/${slug}/sources.json`), sources);
    }

    // Reviews: resolve each by text against what the readers observe now.
    const stored: PreferenceReviews = {};
    if (reviews.length) {
      const observed = readObservedPreferences(home);
      for (const review of reviews) {
        const preference = observed.find((candidate) => candidate.text === review.text);
        if (!preference) throw new Error(`No observed preference "${review.text}"`);
        const scope = preference.scope ?? "global";
        stored[preferenceId(preference)] = {
          status: review.status,
          source_fingerprint: preferenceRevision(preference),
          updated_at: now().toISOString(),
          text: review.edit?.text ?? preference.text,
          scope,
          ...(scope !== "global" && preference.project ? { project: preference.project } : {}),
        };
      }
      writeJson(rel(`library/${PREFERENCE_REVIEW_FILE}`), { version: 1, reviews: stored });
    }

    // The saved suggestion: one lesson per input, two roles, validated on write.
    if (wantSuggestion) {
      const prefs = readObservedPreferences(home);
      const { inputs, selection } = selectSuggestionInputs(prefs, stored, {
        includeUnreviewed: false,
      });
      if (!inputs.length) throw new Error("A suggestion needs at least one preference");
      const lessons: Lesson[] = inputs.map((input, index) => ({
        id: `lesson-${index + 1}`,
        title: `Lesson ${index + 1}`,
        instruction: `${input.text} Apply this whenever the work touches the build or tests.`,
        applies_when: "Any change to the build.",
        exceptions: "",
        disposition: "generalized",
        source_ids: [input.id],
      }));
      const roles: Role[] = [
        {
          name: "build-reviewer",
          display_name: "Build reviewer",
          description: "Reviews build changes for scope and verification.",
          delegate_when: "A change touches the build.",
          not_for: "Writing new features.",
          lesson_ids: lessons.map((lesson) => lesson.id),
        },
        {
          name: "test-planner",
          display_name: "Test planner",
          description: "Plans the tests that prove a change.",
          delegate_when: "A change needs a test plan.",
          not_for: "Reviewing prose.",
          lesson_ids: [lessons[0]?.id ?? "lesson-1"],
        },
      ];
      const parts = { inputs, lessons, set_aside: [], roles, shared: [], playbooks: [] };
      const artifact: SuggestionArtifact = {
        version: 1,
        generated_at: now().toISOString(),
        prompt_versions: { ...SUGGEST_PROMPT_VERSIONS },
        runner: "claude",
        models: { generalize: SAMPLE_MODEL, propose: SAMPLE_MODEL, author: SAMPLE_MODEL },
        source_hash: suggestionFingerprint(inputs, stored),
        selection,
        projects: [...new Set(sessions.map((s) => s.project))].sort(),
        ...parts,
        coverage: computeCoverage(parts),
      };
      writeSuggestion(home, artifact);
    }

    return {
      dir: home,
      exports: sessions.map((session) => session.exportName),
      path: rel,
      read: (relative) => fs.readFileSync(rel(relative), "utf8"),
      json: (relative) => JSON.parse(fs.readFileSync(rel(relative), "utf8")),
      remove() {
        if (owned) fs.rmSync(home, { recursive: true, force: true });
      },
    };
  }
}

/**
 * A complete small home: two projects, three sessions, digests with two
 * cited preferences, two tasks with library entries, one accepted review,
 * and a saved suggestion.
 */
export function sampleHome(options: HomeBuilderOptions = {}): HomeBuilder {
  return homeBuilder(options)
    .session({
      project: "alpha",
      sessionId: "a1111111-0000-4000-8000-000000000001",
      messages: [
        "Please keep the change small, run the whole test suite before you finish, and tell me what changed.",
        "Looks good, ship it.",
      ],
    })
    .session({
      project: "alpha",
      sessionId: "a2222222-0000-4000-8000-000000000002",
      messages: ["Fix the flaky build step and keep the change small so it is easy to review."],
    })
    .session({
      project: "beta",
      sessionId: "b3333333-0000-4000-8000-000000000003",
      messages: ["Write the release notes in plain words, no marketing tone."],
    })
    .digest(0, {
      preferences: [{ text: "Keep changes small.", quote: "keep the change small" }],
    })
    .digest(1, {
      preferences: [{ text: "Keep changes small.", quote: "keep the change small" }],
    })
    .digest(2, {
      domain: "writing",
      preferences: [
        {
          text: "Write release notes in plain words.",
          quote: "plain words, no marketing tone",
          scope: "project",
        },
      ],
    })
    .task({ slug: "fix-build-step", members: [0, 1] })
    .task({ slug: "write-release-notes", members: [2] })
    .library("fix-build-step")
    .library("write-release-notes")
    .review("Keep changes small.", "accepted")
    .suggestion();
}

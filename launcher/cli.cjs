#!/usr/bin/env node

// Entry point for both published commands: `human-hindsight` runs this file
// directly, and `cc-hindsight` requires it and calls `run`. It checks the Node
// version before Node parses the application bundle, which needs newer syntax.
//
// Syntax floor: this file must parse and print its message on the oldest Node a
// person may still have. Claimed: Node 18. Evidence: scripts/check-pack.mjs runs
// `node --check` on the packed copy with a Node 18 binary, and
// scripts/smoke-install.mjs runs both installed commands on Node 18. No older
// release is claimed because none was run. The code still sticks to ES2017
// syntax (no optional chaining, no `??`, no optional catch binding) so that it
// stays readable by older runtimes too.

// The application's requirement, matching `engines` in package.json
// (`^22.13.0 || >=23.4.0`), in words: 23.0 to 23.3 are refused too, so a
// plain "22.13 or newer" would not be true.
const REQUIRED = "Node.js 22.13 or newer in the 22 line, or 23.4 or newer";

/**
 * True when `version` (a value of `process.versions.node`) can run the bundle:
 * 22.13+ on the 22 line, 23.4+ on the 23 line, or any 24 and later. The numeric
 * release decides; a pre-release or nightly suffix is ignored, so 24.0.0-rc.1
 * and 25.0.0-nightly builds are accepted. Anything unparseable is rejected.
 */
function isSupportedNode(version) {
  const release = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.+-]*)?$/.exec(String(version));
  if (!release) return false;
  const major = Number(release[1]);
  const minor = Number(release[2]);
  if (major === 22) return minor >= 13;
  if (major === 23) return minor >= 4;
  return major >= 24;
}

/** One plain line: exactly which versions work, and what was found. */
function requirementLine(version) {
  const found = version ? String(version) : "an unknown version";
  return `Human Hindsight needs ${REQUIRED}; you have ${found}.`;
}

// Version managers, in the order they are suggested when none owns the running
// Node. Each command runs Node.js 24 for one command or one shell and changes
// no global default.
const MANAGERS = [
  {
    id: "mise",
    owns: /[\\/]mise[\\/]installs[\\/]/,
    command: () => "mise exec node@24 -- npx human-hindsight",
  },
  {
    id: "fnm",
    owns: /[\\/]fnm[\\/]|fnm_multishells/,
    command: () => "fnm install 24 && fnm exec --using=24 npx human-hindsight",
  },
  {
    id: "nvm",
    owns: /[\\/]\.?nvm[\\/]versions[\\/]/,
    command: (found) =>
      found.loaded
        ? "nvm install 24 && nvm exec 24 npx human-hindsight"
        : // The braces are shell parameter expansion, escaped so JavaScript keeps them literal.
          `. "\${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm install 24 && nvm exec 24 npx human-hindsight`,
  },
  {
    id: "volta",
    owns: /[\\/]\.?volta[\\/]/,
    command: () => "volta run --node 24 npx human-hindsight",
  },
  {
    id: "asdf",
    owns: /[\\/]\.?asdf[\\/]installs[\\/]/,
    command: () =>
      'asdf install nodejs latest:24 && ASDF_NODEJS_VERSION="$(asdf latest nodejs 24)" npx human-hindsight',
  },
  {
    id: "brew",
    owns: /[\\/](?:Cellar|homebrew|linuxbrew)[\\/]/,
    command: () =>
      'brew install node@24 && PATH="$(brew --prefix node@24)/bin:$PATH" npx human-hindsight',
  },
];

// Runs Node.js 24 from the npm registry for this one command. Proven from Node 18.
const ZERO_INSTALL = "npx -y -p node@24 -p human-hindsight@latest human-hindsight";

/**
 * The version managers available to this person, the one that owns the running
 * Node first. `isFile(path)` reports an executable file (or, for nvm.sh, any
 * file); it is injected so tests can describe a fake PATH.
 */
function detectManagers(o) {
  const env = o.env || {};
  const win = o.platform === "win32";
  const sep = win ? ";" : ":";
  const slash = win ? "\\" : "/";
  const dirs = String(env.PATH || env.Path || "")
    .split(sep)
    .filter(Boolean);
  const extensions = win ? String(env.PATHEXT || ".EXE;.CMD").split(";") : [""];
  function onPath(name) {
    return dirs.some((dir) =>
      extensions.some((ext) => o.isFile(dir.replace(/[\\/]+$/, "") + slash + name + ext)),
    );
  }
  const found = [];
  for (const manager of MANAGERS) {
    let hit = null;
    if (manager.id === "nvm") {
      // nvm is a shell function, so it is never on PATH. NVM_BIN is set once
      // nvm.sh has been sourced; otherwise look for the script itself.
      const nvmDir = env.NVM_DIR || (env.HOME ? `${env.HOME}/.nvm` : "");
      if (env.NVM_BIN) hit = { loaded: true };
      else if (nvmDir && o.isFile(`${nvmDir}/nvm.sh`)) hit = { loaded: false };
    } else if (manager.id === "asdf") {
      if (onPath("asdf") || env.ASDF_DIR) hit = {};
    } else if (onPath(manager.id)) {
      hit = {};
    }
    if (hit) found.push({ manager: manager, found: hit });
  }
  const execPath = String(o.execPath || "");
  const owner = found.filter((entry) => entry.manager.owns.test(execPath));
  return owner.concat(found.filter((entry) => owner.indexOf(entry) < 0));
}

/** The full message for an unsupported Node, ending with a newline. */
function upgradeMessage(o) {
  const lines = [requirementLine(o.version)];
  const managers = detectManagers(o);
  lines.push("Run it with Node.js 24 without changing your default Node:");
  for (const entry of managers) lines.push(`  ${entry.manager.command(entry.found)}`);
  lines.push(`  ${ZERO_INSTALL}`);
  lines.push(
    "Or install Node.js 24 from https://nodejs.org/en/download, then run your command again.",
  );
  return `${lines.join("\n")}\n`;
}

/** One line naming why the application bundle could not be loaded. */
function loadFailureLine(error) {
  const message = error && typeof error === "object" && error.message ? error.message : error;
  const reason = String(message).split("\n")[0].trim().replace(/\.$/, "") || "unknown error";
  const hint =
    error && error.code === "ERR_MODULE_NOT_FOUND"
      ? " Reinstall human-hindsight and try again."
      : "";
  return `Human Hindsight could not start: ${reason}.${hint}`;
}

/**
 * Check the version, then load the application in this same process so
 * arguments, standard streams, signals, and the exit code pass straight through.
 */
function run(proc, deps) {
  const options = deps || {};
  const load = options.load || (() => import("../dist/cli.js"));
  const versions = proc.versions || {};
  const version = versions.node;
  if (!isSupportedNode(version)) {
    proc.stderr.write(
      upgradeMessage({
        version: version,
        env: proc.env,
        platform: proc.platform,
        execPath: proc.execPath,
        isFile: options.isFile || isFile,
      }),
    );
    proc.exitCode = 1;
    return Promise.resolve();
  }
  return Promise.resolve()
    .then(load)
    .then(
      () => undefined,
      (error) => {
        proc.stderr.write(`${loadFailureLine(error)}\n`);
        proc.exitCode = 1;
      },
    );
}

function isFile(file) {
  // biome-ignore lint/style/useNodejsImportProtocol: Node releases before 14.18 cannot require node: built-ins.
  const fs = require("fs");
  try {
    return fs.statSync(file).isFile();
  } catch (_error) {
    return false;
  }
}

module.exports = {
  isSupportedNode: isSupportedNode,
  requirementLine: requirementLine,
  detectManagers: detectManagers,
  upgradeMessage: upgradeMessage,
  loadFailureLine: loadFailureLine,
  run: run,
};

// `human-hindsight` enters here directly; `cc-hindsight` calls `run` itself.
if (require.main === module) run(process);

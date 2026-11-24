/**
 * gui/session.ts: the browser session key, shared by the server, the `gui`
 * command, and the page.
 *
 * The library may run on a fixed port on a shared machine, so every `/api`
 * route requires the key that `gui` prints. The key travels only in the
 * address fragment (`#token=...`), which a browser never sends to a server, so
 * it never appears in a request line or a log. The page reads it, removes it
 * from the address bar, and sends it in the {@link SESSION_HEADER} header on
 * every request. It also keeps it in this tab's `sessionStorage`, so a reload
 * keeps working: that storage belongs to one tab and one origin, is not sent
 * anywhere, and is gone when the tab closes. A new tab opened without the
 * fragment has no key. A key the server refuses (it was restarted and made a
 * new one) is forgotten, and the page says which command to run.
 *
 * Fragment shape: an optional route, then the key as the last part.
 *   #token=<key>                 no route: the page picks its default tab
 *   #preferences&token=<key>     opens the Preferences overview
 * Routes are encoded with `encodeURIComponent`, so a route never contains `&`.
 *
 * This module has no Node or DOM imports: it is bundled into the page.
 */

export const SESSION_HEADER = "x-hindsight-token";
const TOKEN_PART = /(?:^|&)token=([^&]*)$/;

/** The fragment, without `#`, that carries `route` and the session key. */
export function sessionFragment(route: string, token: string): string {
  return route ? `${route}&token=${token}` : `token=${token}`;
}

/** Split a fragment (with or without `#`) into its session key and its route. */
export function splitFragment(hash: string): { token: string | null; route: string } {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  const match = TOKEN_PART.exec(fragment);
  if (!match) return { token: null, route: fragment };
  return { token: match[1] || null, route: fragment.slice(0, match.index) };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Library requests that always carry the session key as a header and never in
 * the address. `fetchImpl` is injected so tests can record what is sent.
 */
export function sessionApi(
  token: string,
  fetchImpl: FetchLike,
  /** Called with `token` when the server refuses it. */
  onRefused?: (token: string) => void,
) {
  const send = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set(SESSION_HEADER, token);
    const response = await fetchImpl(path, { cache: "no-store", ...init, headers });
    if (response.status === 403) onRefused?.(token);
    return response;
  };
  return {
    send,
    async json<T>(path: string): Promise<T> {
      const response = await send(path);
      if (!response.ok) throw new SessionError(response.status);
      return (await response.json()) as T;
    },
  };
}

/** A refused or failed library request; `refused` means the key was not accepted. */
export class SessionError extends Error {
  readonly refused: boolean;
  constructor(readonly status: number) {
    super(status === 403 ? "Library session refused" : "Library data unavailable");
    this.refused = status === 403;
  }
}

/** The subset of `sessionStorage` the page uses, injected so tests need no browser. */
export interface KeyStorage {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
}
export const KEY_ITEM = "human-hindsight.session-key";
/** The `gui` command for this library, saved after a successful load. */
export const RESTART_COMMAND_ITEM = "human-hindsight.gui-command";
/** The command that starts the library, in the same form as every other command on the page. */
export const PLAIN_GUI_COMMAND = "npx human-hindsight@latest gui";

// Storage can be blocked (site data turned off); the page then keeps the key
// in memory only, which still works until a reload.
function read(storage: KeyStorage | null, name: string): string | null {
  try {
    return storage?.getItem(name) ?? null;
  } catch {
    return null;
  }
}
function attempt(action: () => void): void {
  try {
    action();
  } catch {
    // See `read`.
  }
}

export interface KeyChoice {
  /** The key to send, or null when this tab has none. */
  token: string | null;
  source: "address" | "tab" | "none";
  /** The fragment to put in the address bar instead (no `#`); null when the address held no key part. */
  strippedHash: string | null;
}

/**
 * The key for this page load. A key in the address wins and is stored for
 * this tab; otherwise the tab's stored key is used, as after a reload.
 */
export function chooseSessionKey(hash: string, storage: KeyStorage | null): KeyChoice {
  const { token, route } = splitFragment(hash);
  const hasKeyPart = token !== null || /(?:^|&)token=$/.test(hash.replace(/^#/, ""));
  const strippedHash = hasKeyPart ? route : null;
  if (token) {
    attempt(() => storage?.setItem(KEY_ITEM, token));
    return { token, source: "address", strippedHash };
  }
  const stored = read(storage, KEY_ITEM);
  return stored
    ? { token: stored, source: "tab", strippedHash }
    : { token: null, source: "none", strippedHash };
}

/** Forget `refused`, unless the tab has stored a newer key since that request was sent. */
export function forgetSessionKey(storage: KeyStorage | null, refused: string): void {
  if (read(storage, KEY_ITEM) === refused) attempt(() => storage?.removeItem(KEY_ITEM));
}

export function rememberRestartCommand(storage: KeyStorage | null, command: string): void {
  attempt(() => storage?.setItem(RESTART_COMMAND_ITEM, command));
}

/**
 * What the page says when it has no working key. `stored` is the `gui`
 * command this tab saved for its library, if it ever loaded one; without it
 * the page cannot know the folder, so it says how to add it.
 */
export function sessionHelp(
  refused: boolean,
  stored: string | null,
): { text: string; command: string } {
  const elsewhere = stored
    ? ""
    : " (add --home and the folder if your library is not in the default place)";
  return {
    text: refused
      ? `The library was restarted, so this tab's private key no longer works. Open the new address printed in your terminal. If the library is not running, start it with this command${elsewhere} and open the address it prints:`
      : `This page needs the address printed in your terminal, which includes a private key. Open that address. If the library is not running, start it with this command${elsewhere} and open the address it prints:`,
    command: stored || PLAIN_GUI_COMMAND,
  };
}

/** The recovery text and the command to show with it, from this tab's saved command. */
export function sessionRecovery(
  refused: boolean,
  storage: KeyStorage | null,
): { text: string; command: string } {
  return sessionHelp(refused, read(storage, RESTART_COMMAND_ITEM));
}

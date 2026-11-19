import { SESSION_STATE_KEY } from "../shared/config.js";
import { type AppEvent, type AppState, INITIAL_STATE, reduce } from "./machine.js";

export const STATE_KEY = SESSION_STATE_KEY;

/**
 * Serialises every read-modify-write of the session state. Message handlers run
 * concurrently (each `await` yields), and two interleaved get→reduce→set sequences would
 * silently lose one update — e.g. a `stream:phase` overwriting a `stopRequested`.
 */
let chain: Promise<unknown> = Promise.resolve();

export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

export async function readState(): Promise<AppState> {
  const got = await chrome.storage.session.get(STATE_KEY);
  const s = got[STATE_KEY] as AppState | undefined;
  if (!s || typeof s !== "object") return INITIAL_STATE;
  // Fill fields added in newer versions so an update never crashes on old state.
  return { ...INITIAL_STATE, ...s, captures: { ...INITIAL_STATE.captures, ...s.captures } };
}

export type Listener = (state: AppState, prev: AppState, event: AppEvent) => Promise<void> | void;
const listeners: Listener[] = [];

export function onStateChange(listener: Listener): void {
  listeners.push(listener);
}

/** Reduce one event into the stored state, then run side effects (badge, …). */
export function dispatch(event: AppEvent): Promise<AppState> {
  return serial(async () => {
    const prev = await readState();
    const next = reduce(prev, event);
    if (next !== prev) await chrome.storage.session.set({ [STATE_KEY]: next });
    for (const l of listeners) {
      try {
        await l(next, prev, event);
      } catch (err) {
        console.warn("state listener failed", err);
      }
    }
    return next;
  });
}

// What a screen draws from a store that can be refused for a moment (the runtime restarting, a
// read that timed out on a loaded machine): the last value that was read well, with the refusal
// beside it, so a passing refusal never throws away what the person is doing (Live's Edit
// layout). Only a store that has never been read well shows its refusal alone.
import { useRef } from "react";
import type { Refusal } from "./answer";
import type { Loaded } from "./store";

export interface Shown<T> {
  /** The value to draw: the current one, or the last good one; null before any good read. */
  readonly value: T | null;
  /** The refusal of the latest read, when it was refused; null when it was read well. */
  readonly refused: Refusal | null;
  /** True until the first read has answered at all. */
  readonly loading: boolean;
}

/** The next thing to show, from the last good value and the latest read. */
export function lastGood<T>(previous: T | null, loaded: Loaded<T>): Shown<T> {
  switch (loaded.status) {
    case "ready":
      return { value: loaded.value, refused: null, loading: false };
    case "refused":
      return { value: previous, refused: loaded.refused, loading: false };
    case "loading":
      return { value: previous, refused: null, loading: previous === null };
  }
}

/** `lastGood` across renders: the last good value is kept by the component that reads it. */
export function useLastGood<T>(loaded: Loaded<T>): Shown<T> {
  const kept = useRef<T | null>(null);
  const shown = lastGood(kept.current, loaded);
  kept.current = shown.value;
  return shown;
}

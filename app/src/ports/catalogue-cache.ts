// Where fetched catalogues are kept (WI-0018-14). The text is domain/packages/catalogue-cache.ts's;
// the store only keeps it, one entry per source name.

export interface CatalogueCacheStore {
  /** The text kept for `name`, or null when there is none or it cannot be read. */
  read(name: string): string | null;
  /** Keep `text` for `name`, replacing what was there. */
  write(name: string, text: string): void;
  /** Throw away what is kept for `name`; saying nothing when there was none or it cannot go. */
  forget(name: string): void;
}

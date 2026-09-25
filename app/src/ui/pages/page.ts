// What every app page needs of its DOM, so each can be exercised without one: regions it
// draws into, and the events of its section. The DOM glue is in app.ts.

/** A part of a page that is redrawn whole. */
export interface Region {
  innerHTML: string;
}

export interface PageEvent {
  readonly target: unknown;
  preventDefault(): void;
}

/** A page's section: where its clicks and form submissions are heard. */
export interface Section {
  on(type: "click" | "submit", listener: (event: PageEvent) => void): void;
}

/** Why a runtime list could not be shown, in words for a person. */
export function unavailable(error: string): string {
  return `The InnyTypes runtime cannot answer now (${error}). This page shows it again once the runtime is running.`;
}

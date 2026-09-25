// AppApi: the ONLY surface the app pages may use (plan 0018 §2.4), exposed through the
// preload bridge as `window.inny.app`. Its members (state, inbox, submit, snapshots, actions,
// event types, jobs, cancel, packages, settings, pairing) arrive with WI-0018-11.
export type AppApi = Readonly<Record<string, never>>;

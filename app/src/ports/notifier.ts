// How the shell tells a person something that needs them. Notice kinds, wording and the
// once-only rule are WI-0018-21 (domain/notices); this port is only the raising.

export interface Notice {
  readonly title: string;
  readonly body: string;
}

export interface Notifier {
  raise(notice: Notice): void;
}

// Where a process writes what it did. The one log writer is WI-0018-04; until then an
// adapter prints lines.

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

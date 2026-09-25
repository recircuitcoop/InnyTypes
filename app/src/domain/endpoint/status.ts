// What the Settings page is told about the MCP endpoint (plan 0018 §4.1 point 4): the address
// being served against the address saved, which variable is being ignored, why nothing is
// served, and the warning that clients do not move with it.

export interface McpEndpointStatus {
  /** The URL being served now; null when nothing is. */
  readonly served: string | null;
  /** The URL the setting resolves to (stored, else the variables, else the default); null when it cannot be served. */
  readonly saved: string | null;
  /** Any part of the saved address came from the stored setting. */
  readonly stored: boolean;
  /** Variables that are set and lose to the stored setting, by name. */
  readonly ignoredVariables: readonly string[];
  /** Why nothing is served, or why the saved address is not the one served; null when they agree. */
  readonly problem: string | null;
  /** Shown beside the edit: moving the endpoint does not move a client. */
  readonly warning: string;
}

export const CLIENTS_MUST_BE_UPDATED =
  "Moving the endpoint does not move your MCP clients: every client configured with the old " +
  "URL must be updated to the new one. The bearer token stays the same.";

// The loopback MCP endpoint's address (plan 0018 §4.1 points 3 and 4, the port of
// anytype_mcp/endpoint.py and gateway.py's configured_endpoint): the one rule about which
// addresses may be served, the one spelling of the URL, and the one reading of the stored
// setting against INNYTYPES_MCP_HOST and INNYTYPES_MCP_PORT.
//
// Nothing here opens a socket, reads a file or looks at the environment. The gateway binds what
// this answers, the Settings page shows what this answers, and a stored value is judged by it as
// it is written and again as it is read, so the two can never disagree.

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 31010;
export const MCP_PATH = "/mcp";

/** The two variables plan 0007 introduced; plan 0008 made them the default only. */
export const MCP_HOST_VARIABLE = "INNYTYPES_MCP_HOST";
export const MCP_PORT_VARIABLE = "INNYTYPES_MCP_PORT";

/** The loopback MCP service cannot be configured, moved or started safely. */
export class EndpointError extends Error {
  override name = "EndpointError";
}

/** The stored setting: either key may be absent, and each wins over its variable on its own. */
export interface StoredEndpoint {
  readonly host?: string;
  readonly port?: number;
}

/** The address this installation serves, and what it disregarded in order to say so. */
export interface ConfiguredEndpoint {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  /** Any part of the address came from the stored setting. */
  readonly stored: boolean;
  /** Every variable that was set and lost to the stored setting, by name. */
  readonly ignoredVariables: readonly string[];
}

/** The four decimal parts of a dotted IPv4 address, or null when `text` is not one. */
function ipv4Parts(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part))) {
    return null;
  }
  const numbers = parts.map(Number);
  return numbers.every((part) => part <= 255) ? numbers : null;
}

/** The eight 16-bit groups of an IPv6 address, or null when `text` is not one. */
function ipv6Groups(text: string): number[] | null {
  const halves = text.split("::");
  if (halves.length > 2) {
    return null;
  }
  const groups = (half: string | undefined): string[] | null =>
    half === undefined || half === "" ? [] : half.split(":");
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  if (head === null || tail === null) {
    return null;
  }
  const spelled = [...head, ...tail];
  if (!spelled.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group))) {
    return null;
  }
  const missing = 8 - spelled.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) {
    return null;
  }
  const zeros = halves.length === 2 ? Array<string>(missing).fill("0") : [];
  return [...head, ...zeros, ...tail].map((group) => parseInt(group, 16));
}

/**
 * Whether `host` is a numeric loopback address: 127.0.0.0/8, or ::1 however it is spelled.
 * A name is never one, even `localhost`: a name is resolved by something this app does not own.
 */
export function isNumericLoopback(host: string): boolean {
  const v4 = ipv4Parts(host);
  if (v4 !== null) {
    return v4[0] === 127;
  }
  const v6 = ipv6Groups(host);
  return v6 !== null && v6.slice(0, 7).every((group) => group === 0) && v6[7] === 1;
}

/** Whether `host` is a numeric address of either family, loopback or not. */
function isNumericAddress(host: string): boolean {
  return ipv4Parts(host) !== null || ipv6Groups(host) !== null;
}

/**
 * `host` and `port` if this service may serve them, or the reason it may not (endpoint.py:44).
 * Port 0, the way to ask the kernel to choose, is refused: a client told an address must find
 * the service there or find nothing (plan 0007).
 */
export function checkedAddress(host: string, port: number): { host: string; port: number } {
  if (!isNumericAddress(host)) {
    throw new EndpointError("the MCP address must be a numeric loopback address");
  }
  if (!isNumericLoopback(host)) {
    throw new EndpointError(
      "the MCP address must be loopback; wildcard and network binds are refused",
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new EndpointError("the MCP port must be between 1 and 65535");
  }
  return { host, port };
}

/** The Streamable HTTP MCP URL one address is served at; an IPv6 address is bracketed. */
export function endpointUrl(host: string, port: number): string {
  const bracketed = host.includes(":") ? `[${host}]` : host;
  return `http://${bracketed}:${String(port)}${MCP_PATH}`;
}

/** A whole number as INNYTYPES_MCP_PORT may spell it, or null. */
function wholeNumber(text: string): number | null {
  const trimmed = text.trim();
  return /^[+-]?\d+$/.test(trimmed) ? Number(trimmed) : null;
}

/**
 * The address this installation is configured to serve: stored first, the variables after,
 * then the documented default (gateway.py:90-151). Key by key: a stored port beats only
 * INNYTYPES_MCP_PORT, and a stored host only INNYTYPES_MCP_HOST. A variable that loses is named,
 * and one that is not consulted cannot break the reading.
 */
export function configuredEndpoint(
  stored: StoredEndpoint,
  variables: Readonly<Record<string, string | undefined>>,
): ConfiguredEndpoint {
  const ignored: string[] = [];

  let host: string;
  if (stored.host !== undefined) {
    host = stored.host;
    if (variables[MCP_HOST_VARIABLE] !== undefined) {
      ignored.push(MCP_HOST_VARIABLE);
    }
  } else {
    host = variables[MCP_HOST_VARIABLE]?.trim() || DEFAULT_HOST;
  }

  let port: number;
  if (stored.port !== undefined) {
    port = stored.port;
    if (variables[MCP_PORT_VARIABLE] !== undefined) {
      ignored.push(MCP_PORT_VARIABLE);
    }
  } else {
    const spelled = variables[MCP_PORT_VARIABLE];
    const read = spelled === undefined ? DEFAULT_PORT : wholeNumber(spelled);
    if (read === null) {
      throw new EndpointError(`${MCP_PORT_VARIABLE} must be a whole number`);
    }
    port = read;
  }

  // Judged again even though a stored value was judged as it was written: a settings file
  // edited by hand never reaches the listener unchecked.
  checkedAddress(host, port);
  return {
    host,
    port,
    url: endpointUrl(host, port),
    stored: stored.host !== undefined || stored.port !== undefined,
    ignoredVariables: ignored,
  };
}

/**
 * Whether a Host header names exactly the served address (gateway.py:564): a name that
 * resolves to 127.0.0.1, or the right address on another port, is the DNS-rebinding path.
 */
export function isTrustedHost(value: string | undefined, host: string, port: number): boolean {
  return value === `${host}:${String(port)}` || value === `[${host}]:${String(port)}`;
}

/**
 * Whether an Origin header may speak to the served port (gateway.py:570). No Origin at all is
 * allowed: a browser attaches one and an ordinary MCP client sends none. One that is present
 * must be a numeric loopback address on this very port; `null`, a name, or another port is not.
 */
export function isTrustedOrigin(value: string | undefined, port: number): boolean {
  if (value === undefined) {
    return true;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  return isNumericLoopback(hostname) && parsed.port === String(port);
}

// The MCP endpoint's address (plan 0018 §4.1 points 3 and 4; WI-0018-19): the one rule about
// what may be served, the one spelling of the URL, the stored setting against the variables,
// and the Host and Origin a request must carry. Ported from tests/test_anytype_mcp_gateway.py
// and tests/test_independent_client_connection.py.
import { describe, expect, it } from "vitest";
import {
  checkedAddress,
  configuredEndpoint,
  DEFAULT_HOST,
  DEFAULT_PORT,
  EndpointError,
  endpointUrl,
  isNumericLoopback,
  isTrustedHost,
  isTrustedOrigin,
} from "../../src/domain/endpoint/address";

describe("the address the endpoint may serve", () => {
  it.each([
    ["0.0.0.0", "must be loopback"], // the IPv4 wildcard: every interface, the LAN one included
    ["::", "must be loopback"], // the IPv6 wildcard, which often accepts IPv4 as well
    ["localhost", "numeric loopback"], // a name is resolved by something this app does not own
    ["127.0.0.1.nip.io", "numeric loopback"], // a name that resolves to loopback is still a name
    ["192.168.1.2", "must be loopback"], // a LAN address
    ["10.0.0.5", "must be loopback"], // another LAN address
    ["93.184.216.34", "must be loopback"], // a public address
    ["", "numeric loopback"], // nothing at all
    ["127.0.0.256", "numeric loopback"], // not an address
    ["::ffff:127.0.0.1", "numeric loopback"], // an IPv4-mapped form is not taken for loopback
  ])("refuses %j (%s)", (host, reason) => {
    expect(() => checkedAddress(host, 31010)).toThrow(EndpointError);
    expect(() => checkedAddress(host, 31010)).toThrow(reason);
  });

  it.each([0, -1, 65536, 1.5])("refuses port %d, outside the range a socket has", (port) => {
    expect(() => checkedAddress("127.0.0.1", port)).toThrow("between 1 and 65535");
  });

  it.each(["127.0.0.1", "127.0.0.2", "127.255.255.254", "::1", "0:0:0:0:0:0:0:1", "::0:1"])(
    "accepts the numeric loopback address %s, both families and the whole 127/8 block",
    (host) => {
      expect(checkedAddress(host, 31010)).toEqual({ host, port: 31010 });
      expect(isNumericLoopback(host)).toBe(true);
    },
  );

  it("brackets an IPv6 address in the URL, or the port could not be told from it", () => {
    expect(endpointUrl("127.0.0.2", 32010)).toBe("http://127.0.0.2:32010/mcp");
    expect(endpointUrl("::1", 31010)).toBe("http://[::1]:31010/mcp");
  });
});

describe("the stored setting against INNYTYPES_MCP_HOST and INNYTYPES_MCP_PORT", () => {
  it("with nothing stored leaves the variables in charge, then the default", () => {
    expect(configuredEndpoint({}, { INNYTYPES_MCP_PORT: "32999" })).toMatchObject({
      host: "127.0.0.1",
      port: 32999,
      url: "http://127.0.0.1:32999/mcp",
      stored: false,
      ignoredVariables: [],
    });
    expect(
      configuredEndpoint({}, { INNYTYPES_MCP_HOST: "::1", INNYTYPES_MCP_PORT: "32999" }).url,
    ).toBe("http://[::1]:32999/mcp");
    expect(configuredEndpoint({}, {})).toMatchObject({ host: DEFAULT_HOST, port: DEFAULT_PORT });
    expect(configuredEndpoint({}, { INNYTYPES_MCP_HOST: "  " }).host).toBe(DEFAULT_HOST);
  });

  it("serves the stored address, not the variables: the setting wins", () => {
    const stored = { host: "127.0.0.2", port: 32010 };
    const variables = { INNYTYPES_MCP_HOST: "127.0.0.3", INNYTYPES_MCP_PORT: "31999" };
    expect(configuredEndpoint(stored, variables)).toMatchObject({
      host: "127.0.0.2",
      port: 32010,
      stored: true,
    });
  });

  it("names every variable it is ignoring, and none that is unset or not overridden", () => {
    const stored = { host: "127.0.0.2", port: 32010 };
    expect(
      configuredEndpoint(stored, { INNYTYPES_MCP_HOST: "127.0.0.3", INNYTYPES_MCP_PORT: "31999" })
        .ignoredVariables,
    ).toEqual(["INNYTYPES_MCP_HOST", "INNYTYPES_MCP_PORT"]);
    expect(configuredEndpoint(stored, {}).ignoredVariables).toEqual([]);
    const untouched = configuredEndpoint({}, { INNYTYPES_MCP_PORT: "31999" });
    expect(untouched.stored).toBe(false);
    expect(untouched.ignoredVariables).toEqual([]);
  });

  it("lets each stored key win on its own: a stored port does not take the host with it", () => {
    const endpoint = configuredEndpoint(
      { port: 32010 },
      { INNYTYPES_MCP_HOST: "127.0.0.3", INNYTYPES_MCP_PORT: "31999" },
    );
    expect([endpoint.host, endpoint.port]).toEqual(["127.0.0.3", 32010]);
    expect(endpoint.ignoredVariables).toEqual(["INNYTYPES_MCP_PORT"]);
  });

  it("keeps a stored port when the variable it beats is unreadable, and refuses it otherwise", () => {
    const variables = { INNYTYPES_MCP_PORT: "thirty-one-thousand" };
    expect(configuredEndpoint({ host: "127.0.0.1", port: 32010 }, variables).port).toBe(32010);
    expect(() => configuredEndpoint({}, variables)).toThrow(
      "INNYTYPES_MCP_PORT must be a whole number",
    );
  });

  it.each([
    [{}, { INNYTYPES_MCP_PORT: "0" }, "the MCP port must be between 1 and 65535"],
    [
      {},
      { INNYTYPES_MCP_HOST: "0.0.0.0" },
      "the MCP address must be loopback; wildcard and network binds are refused",
    ],
    [{}, { INNYTYPES_MCP_HOST: "localhost" }, "the MCP address must be a numeric loopback address"],
    [{ host: "192.168.1.2" }, {}, "must be loopback"],
  ])("judges what it reads by the same rule: %j %j is refused", (stored, variables, reason) => {
    expect(() => configuredEndpoint(stored, variables)).toThrow(reason);
  });
});

describe("who may speak to the endpoint", () => {
  it.each([
    ["innytypes.attacker.example", "a name the browser was told is this service"],
    ["127.0.0.1:1", "the right address on a port this service does not own"],
    [undefined, "no Host at all"],
    ["localhost:4000", "a name rather than the address"],
  ])("refuses the Host %j (%s)", (host: string | undefined, why: string) => {
    expect(isTrustedHost(host, "127.0.0.1", 4000), why).toBe(false);
  });

  it("trusts exactly the served address, bracketed for IPv6", () => {
    expect(isTrustedHost("127.0.0.1:4000", "127.0.0.1", 4000)).toBe(true);
    expect(isTrustedHost("[::1]:4000", "::1", 4000)).toBe(true);
  });

  it.each([
    ["http://innytypes.attacker.example", "a page served by a real site"],
    ["http://localhost:4000", "a name rather than an address"],
    ["http://127.0.0.1:1", "loopback, on another port"],
    ["null", "an opaque origin"],
    ["http://192.168.1.2:4000", "the right port on the LAN"],
  ])("refuses the Origin %s (%s)", (origin) => {
    expect(isTrustedOrigin(origin, 4000)).toBe(false);
  });

  it("allows no Origin (an ordinary client sends none) and a loopback one on this port", () => {
    expect(isTrustedOrigin(undefined, 4000)).toBe(true);
    expect(isTrustedOrigin("http://127.0.0.1:4000", 4000)).toBe(true);
    expect(isTrustedOrigin("http://[::1]:4000", 4000)).toBe(true);
  });
});

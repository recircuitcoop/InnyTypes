// electron-builder's `latest-*.yml`, parsed and picked apart (WI-0018-24).
import { describe, expect, it } from "vitest";
import {
  metadataFileName,
  parseReleaseMetadata,
  pickReleaseFile,
  ReleaseMetadataError,
} from "../../src/domain/update/release-metadata";

const VALID = [
  "version: 1.2.3",
  "files:",
  "  - url: InnyTypes-1.2.3-arm64-mac.zip",
  "    sha512: abc123==",
  "    size: 12345",
  "  - url: InnyTypes-1.2.3-x64-mac.zip",
  "    sha512: def456==",
  "    size: 12399",
  "path: InnyTypes-1.2.3-arm64-mac.zip",
  "sha512: abc123==",
  "releaseDate: '2026-09-27T00:00:00.000Z'",
  "",
].join("\n");

describe("metadataFileName", () => {
  it("names a channel's per-platform file the way electron-builder does", () => {
    expect(metadataFileName("latest", "mac")).toBe("latest-mac.yml");
    expect(metadataFileName("beta", "linux")).toBe("beta-linux.yml");
  });
});

describe("parseReleaseMetadata", () => {
  it("reads the version and every file", () => {
    const metadata = parseReleaseMetadata(VALID);
    expect(metadata.version).toBe("1.2.3");
    expect(metadata.files).toEqual([
      { url: "InnyTypes-1.2.3-arm64-mac.zip", sha512: "abc123==", size: 12345 },
      { url: "InnyTypes-1.2.3-x64-mac.zip", sha512: "def456==", size: 12399 },
    ]);
  });

  it("reads a single-file document with no arch segment at all", () => {
    const text = [
      "version: 2.0.0",
      "files:",
      "  - url: InnyTypes-2.0.0-linux.AppImage",
      "    sha512: xyz==",
      "    size: 999",
      "releaseDate: '2026-01-01T00:00:00.000Z'",
    ].join("\n");
    expect(parseReleaseMetadata(text).files).toHaveLength(1);
  });

  it("ignores blank lines and comments", () => {
    const text = `# a comment\n\n${VALID}\n\n`;
    expect(parseReleaseMetadata(text).version).toBe("1.2.3");
  });

  const refuse = (text: string, reason: string): void => {
    const error: unknown = (() => {
      try {
        parseReleaseMetadata(text);
        return null;
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(ReleaseMetadataError);
    expect(error).toMatchObject({ reason });
  };

  it("refuses a line that is not key: value", () => {
    refuse(
      "version: 1.0.0\nfiles:\n  - url: a\n    sha512: b\n    size: 1\nnot a line",
      "malformed",
    );
  });

  it("refuses an unknown top-level key", () => {
    refuse(
      "version: 1.0.0\nfiles:\n  - url: a\n    sha512: b\n    size: 1\nbogus: nope",
      "unknown-key",
    );
  });

  it("refuses a key that appears twice", () => {
    refuse(
      "version: 1.0.0\nversion: 2.0.0\nfiles:\n  - url: a\n    sha512: b\n    size: 1",
      "malformed",
    );
  });

  it("refuses a missing version", () => {
    refuse("files:\n  - url: a\n    sha512: b\n    size: 1", "missing-version");
  });

  it("refuses files: holding an inline value", () => {
    refuse("version: 1.0.0\nfiles: not-a-sequence", "malformed");
  });

  it("refuses an empty files: block", () => {
    refuse("version: 1.0.0\nfiles:\npath: x", "missing-files");
  });

  it("refuses an unknown file key", () => {
    refuse(
      "version: 1.0.0\nfiles:\n  - url: a\n    sha512: b\n    size: 1\n    bogus: c",
      "malformed-file",
    );
  });

  it("refuses a file missing a required field", () => {
    refuse("version: 1.0.0\nfiles:\n  - url: a\n    sha512: b", "malformed-file");
  });

  it("refuses a size that is not a whole number", () => {
    refuse("version: 1.0.0\nfiles:\n  - url: a\n    sha512: b\n    size: nope", "malformed-file");
    refuse("version: 1.0.0\nfiles:\n  - url: a\n    sha512: b\n    size: 1.5", "malformed-file");
  });
});

describe("pickReleaseFile", () => {
  const files = parseReleaseMetadata(VALID).files;

  it("picks the file matching this machine's arch", () => {
    expect(pickReleaseFile(files, "arm64").url).toBe("InnyTypes-1.2.3-arm64-mac.zip");
    expect(pickReleaseFile(files, "x64").url).toBe("InnyTypes-1.2.3-x64-mac.zip");
  });

  it("picks the one file when there is only one, regardless of its name", () => {
    const one = [{ url: "InnyTypes-1.2.3-linux.AppImage", sha512: "x", size: 1 }];
    expect(pickReleaseFile(one, "arm64")).toBe(one[0]);
  });

  it("refuses an architecture none of several files name", () => {
    expect(() => pickReleaseFile(files, "ia32")).toThrow(ReleaseMetadataError);
    expect(() => pickReleaseFile(files, "ia32")).toThrow(/no-matching-file|architecture/);
  });

  it("refuses when more than one file would match", () => {
    const ambiguous = [
      { url: "a-arm64.zip", sha512: "x", size: 1 },
      { url: "b-arm64-extra.zip", sha512: "y", size: 2 },
    ];
    let error: unknown;
    try {
      pickReleaseFile(ambiguous, "arm64");
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toMatchObject({ reason: "ambiguous-file" });
  });
});

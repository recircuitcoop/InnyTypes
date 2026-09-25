// Reading a package's files, from its published archive or from a folder (WI-0018-15).
//
// Both give the package's regular files in memory, by relative path with `/` separators.
// Nothing is judged here beyond what reading needs: a path that leaves the package, a link or
// a device is refused, because it could not be written back as the file it claims to be. The
// signature and the hashes are the use case's (application/package-environment.ts).

export interface PackageSource {
  /** Every file of a `.tgz` package archive. Rejects when it cannot be read as one. */
  readArchive(archivePath: string): Promise<ReadonlyMap<string, Uint8Array>>;
  /** Every file under a package folder (a path install). Rejects when it cannot be read. */
  readFolder(folder: string): Promise<ReadonlyMap<string, Uint8Array>>;
}

// Checking a minisign signature (plan 0018 §2.3, §3; WI-0018-14). The rule of plan 0003 D10:
// trust the signature, never the server. Catalogues, packages and releases all go through it.

export interface SignatureVerifier {
  /**
   * Verify `content` against a detached minisign signature and a public key (a `.pub` file or
   * its bare key line). Returns the trusted comment; throws domain/signature/minisign.ts's
   * MinisignError, with its reason, on every failure.
   */
  verify(content: Uint8Array, signature: string, publicKey: string): string;
}

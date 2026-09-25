// The verified node packages (plan 0018 §2.3): the only packages whose types a deploy may name
// (spec 11.3, WI-0018-08).
//
// Verification (signature, lock, own environment) arrives with WI-0018-15 and WI-0018-16. Until
// then the one adapter lists the first-party packages shipped with the app and the test
// fixtures, by the `package` name their inny-package.json declares.

export interface PackageStore {
  /** The names (inny-package.json `package`) of every verified package installed. */
  packages(): readonly string[];
}

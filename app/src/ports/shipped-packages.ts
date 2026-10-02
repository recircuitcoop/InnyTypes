// The node packages that ship inside the app (plan 0022 §H, D17): the folders beside it, at
// PACKAGE_ROOTS[0] = `<APP_DIR>/../packages`, each read for its inny-package.json.
//
// adapters/fs/declared-package-store.ts answers it when given that one root, and only that
// one: the test fixtures' root is never "shipped inside the app".

/** One shipped package folder: the name its declaration gives, and the declaration as read. */
export interface ShippedDeclaration {
  readonly name: string;
  readonly document: unknown;
}

export interface ShippedPackageSource {
  /** Every package found beside the app, by name; a folder that cannot be read is left out. */
  documents(): readonly ShippedDeclaration[];
}

// The component gallery's entry (plan 0022 §L, decision D11): route #/gallery, every atom and
// molecule in every Penpot variant, for the eye and for gallery.e2e.ts's screenshot baselines.
//
// Development builds only. `INNY_BUILD_MODE` is not read at run time: esbuild replaces it with a
// literal at build time (`--define`, app/package.json build:pages; declared in ui/build-mode.d.ts),
// so in a production build the branch below is `"production" !== "production"`. It is not
// `process.env.NODE_ENV`, which only the composition roots may name (React's own builds still
// get that one defined). esbuild drops a dead branch before
// it bundles, and the gallery and React are imported only inside it, so a production main.js
// carries none of them (test/unit/gallery-bundle.test.ts holds it to that). The packaged app
// could not reach this page anyway: the shell serves flat files from dist/ui/pages only.
const mount = document.getElementById("gallery");
if (mount !== null) {
  if (INNY_BUILD_MODE !== "production" && window.location.hash.startsWith("#/gallery")) {
    void Promise.all([import("react-dom/client"), import("./Gallery")]).then(
      ([{ createRoot }, { Gallery }]) => {
        createRoot(mount).render(<Gallery />);
      },
    );
  } else {
    mount.setAttribute("data-refused", "gallery");
  }
}

// The #/gallery route in the app window (plan 0022 §L, decision D11): the component gallery in a
// development build, refused in a production one. `INNY_BUILD_MODE` is replaced by esbuild with a
// literal (ui/build-mode.d.ts), so a production build drops the import below and carries no
// gallery code (test/unit/gallery-bundle.test.ts holds ui/main.tsx to that too).
import { useEffect, useState, type ComponentType } from "react";

export function GalleryScreen() {
  const [Gallery, setGallery] = useState<ComponentType | null>(null);
  useEffect(() => {
    if (INNY_BUILD_MODE !== "production") {
      void import("../gallery/Gallery").then((module) => {
        setGallery(() => module.Gallery);
      });
    }
  }, []);
  if (INNY_BUILD_MODE === "production") {
    return <div data-testid="gallery-refused" data-refused="gallery" />;
  }
  return Gallery === null ? null : <Gallery />;
}

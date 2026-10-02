// The gallery page: a theme switch (light or dark, on the document's data-theme, the attribute
// the generated tokens follow), then the Penpot pages in order. The e2e screenshots each group
// in each theme; a person can flip the theme and see the same.
import { useEffect, useState } from "react";
import { SegmentedControl } from "../components/molecules/SegmentedControl";
import { AtomsPage, IconsPage } from "./atoms";
import { MoleculesPage } from "./molecules";

type Theme = "light" | "dark";

/** The theme the page opened with: `#/gallery?theme=dark`, else light. */
function openingTheme(): Theme {
  return window.location.hash.includes("theme=dark") ? "dark" : "light";
}

export function Gallery() {
  const [theme, setTheme] = useState<Theme>(openingTheme);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  return (
    <main data-gallery="innytypes-component-gallery" className="flex flex-col gap-8 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-page font-semibold text-primary">Components</h1>
        <SegmentedControl
          label="Theme"
          value={theme}
          onValueChange={(value) => {
            setTheme(value === "dark" ? "dark" : "light");
          }}
          options={[
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
      </header>
      <IconsPage />
      <AtomsPage />
      <MoleculesPage />
    </main>
  );
}

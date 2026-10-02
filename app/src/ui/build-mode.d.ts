// The renderer's build mode, replaced by a literal at build time (app/package.json build:pages,
// `--define:INNY_BUILD_MODE=…`): "production" for a packaged build, else "development".
declare const INNY_BUILD_MODE: string;

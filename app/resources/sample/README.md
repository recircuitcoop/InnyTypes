# The 10-second sample

`sample-10s.wav` is what Setup's **Try with a sample** button feeds the starter flow (plan 0022
§H), so the first run is a real run without a recorder or a file of the user's own. It is a
generated tone, released under CC0; `LICENCE.txt` says how it was made.

WI-16 wires Try with a sample once a shipped source watches a folder (see plan D17 note).

Where it is:

- in a packaged app, `<resources>/sample/sample-10s.wav` (`process.resourcesPath`): both
  `app/packaging/electron-builder*.yml` copy this folder there through `extraResources`;
- when run from the repository, `app/resources/sample/sample-10s.wav`.

`app/test/unit/sample-resource.test.ts` holds it to 10 seconds of 16 kHz mono 16-bit PCM WAV,
with this licence beside it.

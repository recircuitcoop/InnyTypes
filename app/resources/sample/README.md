# The 10-second sample

`sample-10s.wav` is what Setup's **Try with a sample** button feeds the starter flow (plan 0022
§H), so the first run is a real run without a recorder or a file of the user's own. It is a
generated tone, released under CC0; `LICENCE.txt` says how it was made.

Try with a sample copies it into the folder Setup's Source folder step chose (the starter flow's
folder source, D18), under a name not taken there, once that source has scanned the folder for
the first time (`app/src/shell/setup-starter.ts`): the files already there at its first scan are
never passed on.

Where it is:

- in a packaged app, `<resources>/sample/sample-10s.wav` (`process.resourcesPath`): both
  `app/packaging/electron-builder*.yml` copy this folder there through `extraResources`;
- when run from the repository, `app/resources/sample/sample-10s.wav`.

`app/test/unit/sample-resource.test.ts` holds it to 10 seconds of 16 kHz mono 16-bit PCM WAV,
with this licence beside it.

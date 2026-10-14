# folder — the official folder source

One node type, `watch`: it starts a run for each new file that appears in one folder. Its
behaviour and known limits are in its declaration (`inny-package.json`) and in plan 0022, D18.

## The status it promises

The `watch` node shows its status through the SDK. One status is a contract, not only a
display, because InnyTypes' Setup acts on it (`app/src/shell/setup-starter.ts`,
`FIRST_SCAN_STATUS`, read through the runtime's `node.status`):

| Status                                              | Meaning                                                                                                                                            |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ text: "watching", fill: "green", shape: "dot" }` | The first scan of the folder has finished. A file that appears from now on is passed on; the files already there were taken as the starting point. |

Every other status this node shows is for people to read and may change. Changing the one above
is a breaking change: change `FIRST_SCAN_STATUS` with it, and the folder-source integration test
(`app/test/integration/folder-source.test.ts`) will fail until both agree.

// Refused by the ui rule: the renderer never reaches Electron directly, only through AppApi.
import { app } from "electron";

export const leak = app;

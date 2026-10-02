// Allowed by the ui rule (plan 0022 §J): the three UI libraries, and another ui file.
import { Dialog } from "@ark-ui/react";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { jsx } from "react/jsx-runtime";
import { leak } from "./electron-leak";

export const allowed = [Dialog, createRoot, useState, jsx, leak] as const;

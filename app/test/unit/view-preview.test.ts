// Preview a view… (plan 0021 D4): which types a preview can draw and the view it draws
// (domain/views/preview.ts), and the development build's menu item that opens one
// (shell/view-preview.ts). The window itself is the adapter's, in popouts.test.ts.

import type { Menu, MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vitest";

import {
  previewChoices,
  previewElement,
  previewId,
  previewView,
} from "../../src/domain/views/preview";
import { PREVIEW_MENU_ITEM, previewOn, wirePreview } from "../../src/shell/view-preview";
import { RecordingLogger } from "../fixtures/raw-node/fixture";

const KIT = {
  name: "widget_kit",
  document: {
    types: [
      {
        id: "re_order",
        kind: "view",
        view: "action",
        label: "Reorder",
        props: { type: "object", examples: [{ items: ["Grace", "Ada"] }, { items: [] }] },
      },
      // No props: drawn by the generic renderer, or a widget with no declared input.
      { id: "ask", kind: "view", view: "action", label: "Ask" },
      { id: "card", kind: "view", view: "snapshot", label: "Card", props: { type: "object" } },
      { id: "source", kind: "source", label: "Source", props: { type: "object" } },
      { id: "plain", kind: "view", view: "action", props: { type: "object" } },
      { kind: "view", view: "action", props: {} },
      "not a type",
    ],
  },
};

describe("the types a preview draws", () => {
  it("are action views with props, each with its first example as sample props", () => {
    const choices = previewChoices([
      KIT,
      { name: "broken", document: null },
      { name: "odd", document: { types: "none" } },
    ]);
    expect(choices).toEqual([
      {
        package: "widget_kit",
        type: "re_order",
        label: "Reorder",
        props: { items: ["Grace", "Ada"] },
      },
      // No label: its id; no example: no props.
      { package: "widget_kit", type: "plain", label: "plain", props: {} },
    ]);
  });

  it("draws the type's own element on its package's origin, shaped as the runtime's view", () => {
    const [reorder] = previewChoices([KIT]);
    if (reorder === undefined) {
      throw new Error("no choice");
    }
    expect(previewElement(reorder)).toBe("widget-kit-re-order");
    expect(previewId(reorder)).toBe("widget_kit-re_order");
    expect(previewView(reorder)).toEqual({
      kind: "view",
      id: "widget_kit-re_order",
      type: "inny-widget_kit-re_order",
      package: "widget_kit",
      content: {
        title: "Reorder",
        component: { element: "widget-kit-re-order", props: { items: ["Grace", "Ada"] } },
      },
      window: "popout",
      draft: null,
    });
  });
});

// ── the menu item ────────────────────────────────────────────────────────────────────────

function harness(response: number, documents = [KIT]) {
  let set: MenuItemConstructorOptions[] | null = null;
  const asked: { buttons?: string[]; cancelId?: number; detail?: string }[] = [];
  const previews: { id: string; value: unknown }[] = [];
  const logger = new RecordingLogger();
  const existing = { label: "File" } as unknown as Menu["items"][number];
  wirePreview({
    menu: {
      getApplicationMenu: () => ({ items: [existing] }),
      setApplicationMenu: () => undefined,
      buildFromTemplate: (template) => {
        set = template as MenuItemConstructorOptions[];
        return {} as Menu;
      },
    },
    dialog: {
      showMessageBox: (options: { buttons?: string[]; cancelId?: number; detail?: string }) => {
        asked.push(options);
        return Promise.resolve({ response, checkboxChecked: false });
      },
    } as never,
    documents: () => documents,
    preview: (id, value) => previews.push({ id, value }),
    logger,
  });
  const menu = set as MenuItemConstructorOptions[] | null;
  const develop = menu?.[1];
  const item = (develop?.submenu as MenuItemConstructorOptions[] | undefined)?.[0];
  const press = async (): Promise<void> => {
    (item?.click as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { menu, develop, item, press, asked, previews, logger, existing };
}

describe("Preview a view…", () => {
  it("is there in a build that is not installed, or with INNY_DEV=1, and never otherwise", () => {
    expect(previewOn({ packaged: false, env: {} })).toBe(true);
    expect(previewOn({ packaged: true, env: { INNY_DEV: "1" } })).toBe(true);
    expect(previewOn({ packaged: true, env: {} })).toBe(false);
    expect(previewOn({ packaged: true, env: { INNY_DEV: "0" } })).toBe(false);
  });

  it("is a Develop menu after the application menu's own", () => {
    const { menu, develop, item, existing } = harness(0);
    expect(menu?.[0]).toBe(existing);
    expect(develop?.label).toBe("Develop");
    expect(item).toMatchObject({ id: PREVIEW_MENU_ITEM, label: "Preview a view…" });
  });

  it("asks which type, then opens the chosen one with its sample props", async () => {
    const { press, asked, previews, logger } = harness(0);
    await press();
    expect(asked[0]).toMatchObject({ buttons: ["Reorder", "plain", "Cancel"], cancelId: 2 });
    expect(previews).toHaveLength(1);
    expect(previews[0]?.id).toBe("widget_kit-re_order");
    expect(previews[0]?.value).toMatchObject({
      content: { component: { props: { items: ["Grace", "Ada"] } } },
    });
    expect(logger.has(/previewing widget_kit\/re_order/)).toBe(true);
  });

  it("Cancel opens nothing, and with no type to draw it says so", async () => {
    const cancelled = harness(2);
    await cancelled.press();
    expect(cancelled.previews).toEqual([]);
    const none = harness(0, []);
    await none.press();
    expect(none.asked[0]).toMatchObject({ buttons: ["Cancel"], cancelId: 0 });
    expect(none.asked[0]?.detail).toMatch(/No package here declares a view with props/);
    expect(none.previews).toEqual([]);
  });
});

// Preview a view… (plan 0021 §9, D4): a development build's menu item that draws a package's
// widget in the real pop-out sandbox, with its type's sample props, without running a flow. The
// person picks the view type; the answer the widget would send is logged (domain/views/preview.ts,
// adapters/electron/popouts.ts `preview`). Apart from main.ts so the composition root stays under
// its 600 lines (plan 0018 §2.3).

import type { Dialog, Menu, MenuItem, MenuItemConstructorOptions } from "electron";
import { previewChoices, previewId, previewView } from "../domain/views/preview";
import type { Logger } from "../ports/logger";

/** The menu item's id, so the e2e gate can press it. */
export const PREVIEW_MENU_ITEM = "preview-a-view";

/** Electron's Menu, as far as adding the item goes. */
export interface PreviewMenu {
  getApplicationMenu(): Pick<Menu, "items"> | null;
  setApplicationMenu(menu: Menu | null): void;
  buildFromTemplate(template: (MenuItemConstructorOptions | MenuItem)[]): Menu;
}

export interface PreviewDeps {
  readonly menu: PreviewMenu;
  readonly dialog: Pick<Dialog, "showMessageBox">;
  /** The packages found now, each with its declaration as read. */
  readonly documents: () => readonly { readonly name: string; readonly document: unknown }[];
  /** Open the preview `id` of `value` in its pop-out. */
  readonly preview: (id: string, value: unknown) => void;
  readonly logger: Logger;
}

/**
 * Whether the item is there: in a build that is not installed, or with INNY_DEV=1 (the
 * gallery's rule, plan 0022 D11). Never otherwise.
 */
export function previewOn(options: {
  readonly packaged: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}): boolean {
  return !options.packaged || options.env["INNY_DEV"] === "1";
}

/** Add a Develop menu holding Preview a view… after the application menu's own. */
export function wirePreview(deps: PreviewDeps): void {
  const choose = async (): Promise<void> => {
    // Read when asked, so a package added since is offered.
    const choices = previewChoices(deps.documents());
    const { response } = await deps.dialog.showMessageBox({
      type: "question",
      message: "Preview a view",
      detail:
        choices.length === 0
          ? "No package here declares a view with props."
          : "Its widget is drawn with its sample props. Its answer is logged, never sent.",
      buttons: [...choices.map((choice) => choice.label), "Cancel"],
      cancelId: choices.length,
    });
    const chosen = choices[response];
    if (chosen === undefined) {
      return;
    }
    deps.logger.info(`previewing ${chosen.package}/${chosen.type}`);
    deps.preview(previewId(chosen), previewView(chosen));
  };
  const develop: MenuItemConstructorOptions = {
    label: "Develop",
    submenu: [
      {
        id: PREVIEW_MENU_ITEM,
        label: "Preview a view…",
        click: () => {
          void choose();
        },
      },
    ],
  };
  const items = deps.menu.getApplicationMenu()?.items ?? [];
  deps.menu.setApplicationMenu(deps.menu.buildFromTemplate([...items, develop]));
}

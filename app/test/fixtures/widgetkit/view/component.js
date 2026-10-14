// The widget kit's widgets (plan 0021): plain custom elements with no dependencies, served by
// the shell on inny-view://widgetkit/ under the pop-out CSP, styled only with the view kit
// (view-kit.css) and the design tokens the page links. The page draws InnyTypes' chrome under
// them; a widget draws only its body.
//
// - <widgetkit-reorder>: the view's `props.items` (or its draft) as rows, put in order by
//   dragging a row or with its Up and Down buttons. It is valid as soon as it has rows; every
//   move is kept as a draft; `answer()` returns `{order}`.
// - <widgetkit-crash>: throws as it is drawn, so the page falls back to the view's form.
"use strict";

class WidgetkitReorder extends HTMLElement {
  connectedCallback() {
    const view = this.view || {};
    const props = (view.content && view.content.component && view.content.component.props) || {};
    const draft = view.draft && Array.isArray(view.draft.order) ? view.draft.order : null;
    this.order = (draft || (Array.isArray(props.items) ? props.items : [])).map(String);
    this.dragged = null;
    this.draw();
    window.inny.setValid(this.order.length > 0);
  }

  /** Move the row at `from` to `to`, draw again, and keep the order as a draft. */
  move(from, to) {
    if (to < 0 || to >= this.order.length || from === to) {
      return;
    }
    const [item] = this.order.splice(from, 1);
    this.order.splice(to, 0, item);
    this.draw();
    void window.inny.draft({ order: [...this.order] });
  }

  draw() {
    const list = document.createElement("ol");
    list.className = "inny-list";
    list.setAttribute("data-testid", "reorder-list");
    this.order.forEach((item, n) => {
      const row = document.createElement("li");
      row.className = "inny-list-row";
      row.draggable = true;
      row.setAttribute("data-testid", `reorder-row-${n}`);
      const handle = document.createElement("span");
      handle.className = "inny-drag-handle";
      handle.setAttribute("aria-hidden", "true");
      handle.textContent = "⋮⋮";
      const text = document.createElement("span");
      text.textContent = item;
      const up = this.button("Up", `reorder-up-${n}`, () => this.move(n, n - 1));
      const down = this.button("Down", `reorder-down-${n}`, () => this.move(n, n + 1));
      row.addEventListener("dragstart", () => {
        this.dragged = n;
        row.setAttribute("data-dragging", "");
      });
      row.addEventListener("dragover", (event) => event.preventDefault());
      row.addEventListener("drop", (event) => {
        event.preventDefault();
        if (this.dragged !== null) {
          this.move(this.dragged, n);
        }
        this.dragged = null;
      });
      row.append(handle, text, up, down);
      list.append(row);
    });
    this.replaceChildren(list);
  }

  button(label, testid, onPress) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "inny-button";
    button.textContent = label;
    button.setAttribute("data-testid", testid);
    button.addEventListener("click", onPress);
    return button;
  }

  answer() {
    return { order: [...this.order] };
  }
}

class WidgetkitCrash extends HTMLElement {
  connectedCallback() {
    throw new Error("widgetkit-crash breaks as it is drawn");
  }
}

customElements.define("widgetkit-reorder", WidgetkitReorder);
customElements.define("widgetkit-crash", WidgetkitCrash);

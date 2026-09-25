// A third-party view component (WI-0018-11): the pop-out kit's own custom element, served by
// the shell on inny-view://popoutkit/ under the pop-out CSP. It stands for code InnyTypes did
// not write, so it tries everything spec 8.5.9 and arch_pivot P10f say a view page cannot do,
// and draws what happened, for the e2e test to read. It then answers its view through the
// id-less bridge, like any view page.
"use strict";

/** Whether a promise rejected, and with what. */
async function outcome(promise) {
  try {
    await promise;
    return "allowed";
  } catch (error) {
    return `refused: ${error && error.message ? error.message : String(error)}`;
  }
}

async function probe(view) {
  const port = view && view.content && view.content.data ? view.content.data.port : 0;
  const results = {
    require: typeof require,
    process: typeof process,
    module: typeof module,
    electron: typeof window.electron,
    innyKeys: Object.keys(window.inny).sort(),
    appApi: typeof window.inny.app,
    getLength: window.inny.get.length,
  };
  results.fetchRuntime = await outcome(fetch(`http://127.0.0.1:${port}/red/settings`));
  results.fetchFile = await outcome(fetch("file:///etc/hosts"));
  try {
    results.eval = String(eval("1+1"));
  } catch (error) {
    results.eval = error.name;
  }
  try {
    results.newFunction = String(new Function("return 2")());
  } catch (error) {
    results.newFunction = error.name;
  }
  const script = document.createElement("script");
  script.textContent = "window.__innyInlineRan = true;";
  document.body.append(script);
  await new Promise((resolve) => setTimeout(resolve, 50));
  results.inlineScript = window.__innyInlineRan === true ? "ran" : "did not run";
  results.windowOpen = window.open("https://example.com/") === null ? "denied" : "opened";
  results.action = await outcome(window.inny.action("again", {}));
  // The bridge takes no id: asked for another view, it still answers with this window's own.
  const other = await window.inny.get("someone-else");
  results.getOwn = other.ok ? other.value.id : `not ok: ${other.error}`;
  return results;
}

class PopoutkitProbe extends HTMLElement {
  connectedCallback() {
    const view = this.view;
    const out = document.createElement("pre");
    out.setAttribute("data-testid", "component-probes");
    const heading = document.createElement("p");
    heading.setAttribute("data-testid", "component-view-id");
    heading.textContent = view ? view.id : "";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Answer from the component";
    button.setAttribute("data-testid", "component-submit");
    button.addEventListener("click", () => {
      this.dispatchEvent(
        new CustomEvent("inny-submit", {
          detail: { answer: "from the component" },
          bubbles: true,
        }),
      );
    });
    this.append(heading, out, button);
    probe(view).then(
      (results) => {
        out.textContent = JSON.stringify(results);
      },
      (error) => {
        out.textContent = JSON.stringify({ failed: String(error) });
      },
    );
  }
}

customElements.define("popoutkit-probe", PopoutkitProbe);

// Penpot page 05 Templates in the gallery: the five layouts with no content, each region a
// labelled placeholder, as Penpot draws them.
import type { ReactNode } from "react";
import { PageCanvas } from "../components/templates/PageCanvas";
import { PageConfiguration } from "../components/templates/PageConfiguration";
import { PageLive } from "../components/templates/PageLive";
import { WindowPopout } from "../components/templates/WindowPopout";
import { WindowSetup } from "../components/templates/WindowSetup";
import { cx } from "../components/variant";
import { Cell, Group, Page } from "./frame";

/** A region's placeholder: a dashed box named after the region. */
function Region({ name, className }: { readonly name: string; readonly className?: string }) {
  return (
    <div
      data-region={name}
      className={cx(
        "flex items-center justify-center rounded-s border border-dashed border-muted font-mono text-caption text-secondary",
        className,
      )}
    >
      {name}
    </div>
  );
}

const SIDEBAR = (
  <Region name="sidebar" className="h-full w-[var(--inny-size-nav-width)] shrink-0" />
);

function Frame({ children }: { readonly children: ReactNode }) {
  return <div className="h-[360px] w-full">{children}</div>;
}

export function TemplatesPage() {
  return (
    <Page title="05 Templates">
      <Group component="page-configuration">
        <Cell of="page-configuration" width={1152}>
          <Frame>
            <PageConfiguration sidebar={SIDEBAR} tabs={<Region name="tabs" className="h-[40px]" />}>
              <Region name="content" className="h-[200px]" />
            </PageConfiguration>
          </Frame>
        </Cell>
      </Group>
      <Group component="page-live">
        <Cell of="page-live" width={1152}>
          <Frame>
            <PageLive sidebar={SIDEBAR}>
              <Region name="board" className="h-[280px]" />
            </PageLive>
          </Frame>
        </Cell>
      </Group>
      <Group component="page-canvas">
        <Cell of="page-canvas" width={1152}>
          <Frame>
            <PageCanvas sidebar={SIDEBAR}>
              <Region name="canvas frame" className="flex-1" />
            </PageCanvas>
          </Frame>
        </Cell>
      </Group>
      <Group component="window-popout">
        <Cell of="window-popout" width={440}>
          <WindowPopout>
            <Region name="question pop-out" className="m-5 h-[200px]" />
          </WindowPopout>
        </Cell>
      </Group>
      <Group component="window-setup">
        <Cell of="window-setup" width={1152}>
          <Frame>
            <WindowSetup sidebar={SIDEBAR}>
              <Region name="setup step" className="h-[240px]" />
            </WindowSetup>
          </Frame>
        </Cell>
      </Group>
    </Page>
  );
}

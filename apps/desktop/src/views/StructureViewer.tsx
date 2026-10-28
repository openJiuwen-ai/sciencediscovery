// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import "molstar/build/viewer/molstar.css";
import type { BuiltInTrajectoryFormat } from "molstar/lib/mol-plugin-state/formats/trajectory.js";
// Mol* publishes no `exports` map, so every subpath has to name its file: the
// app resolves modules the Node way, which has no directory index.
import { createPluginUI } from "molstar/lib/mol-plugin-ui/index.js";
import type { PluginUIContext } from "molstar/lib/mol-plugin-ui/context.js";
import { DefaultPluginUISpec } from "molstar/lib/mol-plugin-ui/spec.js";
import { PluginCommands } from "molstar/lib/mol-plugin/commands.js";
import type { PluginLayoutStateProps } from "molstar/lib/mol-plugin/layout.js";
import { Color } from "molstar/lib/mol-util/color/index.js";

import { cifTrajectoryFormat, type StructureFormat } from "../molecular.js";
import { TEXT } from "../text.js";

/** Mol*'s name for each format it can parse. A `.cif` is decided per file (see
 *  `cifTrajectoryFormat`), so it is resolved at load time rather than here. */
const MOLSTAR_FORMAT: Record<StructureFormat, BuiltInTrajectoryFormat> = {
  cif: "mmcif",
  mol2: "mol2",
  pdb: "pdb",
  sdf: "sdf",
  xyz: "xyz",
};

/**
 * The two layouts this box is put into, and the reason both are dispatched as
 * commands rather than assigned.
 *
 * `PluginCommands.Layout.Update` is the only runtime path that reaches the
 * plugin's own UI: it merges the state *and* emits `layout.events.updated`,
 * which is what the layout component subscribes to in order to re-render — and
 * the four regions are conditionally rendered on `showControls`, so a value
 * assigned with `plugin.layout.setProps()` would leave the panels unmounted
 * and nobody told.
 *
 * `isExpanded` is deliberately absent from both. Mol* reads it as its own
 * full-screen mode: it rewrites `document.body.style` and moves the viewport
 * meta tag into its own container. This view is an overlay of this app's own
 * making, and the page underneath has to stay exactly where it was.
 */
const COMPACT_LAYOUT: Partial<PluginLayoutStateProps> = {
  regionState: { bottom: "hidden", left: "hidden", right: "hidden", top: "hidden" },
  showControls: false,
};

/** What the full-screen view restores: Mol*'s own panels, as the old front end
 *  mounts them. `reactive` is the display mode that collapses the left and
 *  right panels on a narrow viewport instead of overflowing it.
 *
 *  The bottom region can only be `full` or `hidden` — in this version of Mol*
 *  only `left` has a third, partly-collapsed state — so the log panel is
 *  simply on. */
const FULL_LAYOUT: Partial<PluginLayoutStateProps> = {
  controlsDisplay: "reactive",
  regionState: { bottom: "full", left: "full", right: "full", top: "full" },
  showControls: true,
};

interface Props {
  content: string;
  format: StructureFormat;
  /** The file's name, for the box's accessible label. */
  name: string;
  /** Whether the full-screen view is open. The panel holds the switch, because
   *  one of its two buttons — the document's name — is up there and not in this
   *  box. */
  expanded: boolean;
  onExpand: (next: boolean) => void;
}

/**
 * 结构浏览器 — the 3D view of a structure artifact.
 *
 * It opens in the artifact tab like every other document, inside the design's
 * fixed-aspect box. Mol*'s own panels are built for a full window and a
 * 360 px column has no room for them: in the box the plugin is mounted with its
 * chrome hidden rather than trimmed, and the two control strips it draws over
 * the canvas — the animation picker top left, the viewport buttons on the right
 * — are hidden too, since none of them is about this box. What is left is the
 * one thing worth having: the model. Clicking it, or the document's name above
 * it, opens the same view full screen — the canvas is not remounted, so the
 * angle the model was turned to is the one it keeps — where every panel and
 * every strip comes back, and where Esc and the ✕ both close it.
 *
 * Rendering is left to Mol*'s adaptive preset — cartoon for a polymer,
 * ball-and-stick for a ligand, the symmetry-expanded cell for a crystal — which
 * is the truthful answer before anyone has chosen, and the only one that does
 * not lie. The badge reports the file's format and the atom count read from the
 * plugin's own state.
 */
export default function StructureViewer({ content, expanded, format, name, onExpand }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const pluginRef = useRef<PluginUIContext | null>(null);
  const rootRef = useRef<Root | null>(null);
  /** Which layout the box is in, readable from the mounting effect, which must
   *  not re-run when that changes. */
  const layoutRef = useRef(expanded);
  const [status, setStatus] = useState<"error" | "loading" | "ready">("loading");
  const [message, setMessage] = useState<string>();
  const [atoms, setAtoms] = useState<number>();

  const trajectoryFormat = useMemo(
    () => (format === "cif" ? cifTrajectoryFormat(content) : MOLSTAR_FORMAT[format]),
    [content, format],
  );
  const crystal = trajectoryFormat === "cifCore";

  /** Opening the full-screen view. The listener is a native one rather than
   *  React's `onClick`, because Mol*'s UI is a second React root: a click raised
   *  inside it is not dispatched along this tree's synthetic event path at all. */
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || expanded) return;
    let startX = 0;
    let startY = 0;
    let pointer = -1;
    const down = (event: PointerEvent) => {
      startX = event.clientX;
      startY = event.clientY;
      pointer = event.pointerId;
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId !== pointer || event.button !== 0) return;
      // A drag turns the model; it is not a click. Past a few pixels this was
      // someone rotating what they are looking at.
      if (Math.hypot(event.clientX - startX, event.clientY - startY) > 4) return;
      onExpand(true);
    };
    shell.addEventListener("pointerdown", down);
    shell.addEventListener("pointerup", up);
    return () => {
      shell.removeEventListener("pointerdown", down);
      shell.removeEventListener("pointerup", up);
    };
  }, [expanded, onExpand]);

  /** Esc is the second way out of the full-screen view, next to the ✕. */
  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onExpand(false);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [expanded, onExpand]);

  /** Mol*'s panels come back with the full-screen view and go away with it.
   *  This runs before the resize below, because where the canvas ends up
   *  depends on them having been mounted first. */
  useEffect(() => {
    layoutRef.current = expanded;
    const plugin = pluginRef.current;
    if (plugin) applyLayout(plugin, expanded);
  }, [expanded]);

  /** A size change is a redraw, not a re-frame: the model keeps the angle it was
   *  turned to. The call is the plugin's own `handleResize` and not
   *  `canvas3d.handleResize`, because the latter only recomputes the passes
   *  against the canvas that is already there — measuring the canvas to its
   *  container, and thereby deciding how big it is, is the plugin's job.
   *
   *  The observer is what covers the panel being dragged wider or narrower: the
   *  host box changes without any state changing, so no render of this
   *  component happens and nothing else here would ever run. */
  useEffect(() => {
    const plugin = pluginRef.current;
    const host = hostRef.current;
    if (!plugin) return;
    const resize = () => {
      // A hidden panel — collapsed, or too narrow for the media query — leaves
      // the host at zero size, and the observer still fires for that. Measuring
      // the canvas down to nothing and back is how a WebGL context gets lost,
      // so the box simply keeps the size it had until there is one again.
      if (host !== null && (host.clientWidth === 0 || host.clientHeight === 0)) return;
      try {
        plugin.handleResize();
        // Without a redraw the new region stays blank until the next pointer
        // event, which on a still image can be a long time.
        plugin.canvas3d?.requestDraw();
      } catch {
        /* The plugin can be mid-disposal; a missed resize is not an error. */
      }
    };
    requestAnimationFrame(resize);
    const timer = setTimeout(resize, 250);
    let observer: ResizeObserver | undefined;
    if (host !== null) {
      observer = new ResizeObserver(resize);
      observer.observe(host);
    }
    return () => {
      clearTimeout(timer);
      observer?.disconnect();
    };
    // `status` is what brings the plugin into existence, and an observer has to
    // be watching from then on — not only from the next full-screen toggle, or
    // a structure dragged wider in the panel beside the transcript would keep
    // the size it was first drawn at.
  }, [expanded, status]);

  useEffect(() => {
    let disposed = false;
    setStatus("loading");
    setMessage(undefined);
    setAtoms(undefined);
    void (async () => {
      try {
        const host = hostRef.current;
        if (!host) return;
        const spec = DefaultPluginUISpec();
        // Mol*'s regions are hidden rather than absent: the plugin builds
        // around them, and one value here is all it takes to bring a panel
        // back if this box ever grows into a window.
        spec.layout = {
          initial: {
            isExpanded: false,
            showControls: false,
            regionState: { bottom: "hidden", left: "hidden", right: "hidden", top: "hidden" },
          },
        };
        const plugin = await createPluginUI({
          spec,
          target: host,
          // The stock renderer throws its React root away, which leaves the
          // plugin's own components mounted on a context that is about to be
          // disposed. Keeping the handle is what lets the cleanup unmount them
          // first, in that order.
          render: (element, container) => {
            rootRef.current = createRoot(container as HTMLElement);
            rootRef.current.render(element);
          },
        });
        if (disposed) {
          plugin.dispose();
          return;
        }
        pluginRef.current = plugin;
        // The plugin is built with the compact layout already in its spec, but
        // it can be mounted while the full-screen view is open — a document
        // opened from a link inside another one lands in the tab that is
        // already expanded.
        applyLayout(plugin, layoutRef.current);

        const data = await plugin.builders.data.rawData({ data: content });
        const trajectory = await plugin.builders.structure.parseTrajectory(data, trajectoryFormat);
        // A crystal is only readable as its unit cell: the general preset draws
        // the asymmetric unit alone — two atoms, for rock salt — and hides the
        // cell box. Crystallographic files therefore go through Mol*'s
        // symmetry-expanding preset first, and fall back to the general one
        // (with the cell box, which such a file can still draw) when the file
        // carries no usable symmetry and the preset declines.
        const expanded = crystal
          ? await plugin.builders.structure.hierarchy.applyPreset(trajectory, "unitcell")
          : undefined;
        if (!expanded) {
          await plugin.builders.structure.hierarchy.applyPreset(trajectory, "default", {
            showUnitcell: crystal,
          });
        }
        if (disposed) return;
        setAtoms(atomsOf(plugin));
        setStatus("ready");
        settle(plugin);
      } catch (error) {
        if (disposed) return;
        setStatus("error");
        setMessage(error instanceof Error ? error.message : TEXT.molstar.initFailed);
      }
    })();
    return () => {
      disposed = true;
      // Unmount before disposing: the plugin's React tree subscribes to state
      // the disposal tears down.
      try {
        rootRef.current?.unmount();
      } catch {
        /* Already unmounted. */
      }
      rootRef.current = null;
      try {
        pluginRef.current?.dispose();
      } catch {
        /* Already gone. */
      }
      pluginRef.current = null;
    };
  }, [content, crystal, trajectoryFormat]);

  const badge = [format.toUpperCase(), atoms === undefined ? "" : TEXT.molstar.atoms(atoms)]
    .filter((part) => part !== "")
    .join(" · ");

  return (
    <div
      aria-label={TEXT.molstar.viewerAria(name)}
      className={`molstar-shell${expanded ? " is-fullscreen" : ""}`}
      ref={shellRef}
      role="group"
      title={expanded ? undefined : TEXT.molstar.expand}
    >
      {/* Full screen carries a real header rather than the floating name and
          badge the box uses: Mol*'s panels now own two of those corners, and a
          title laid over the sequence viewer or the log is a title nobody can
          read. */}
      {expanded ? (
        <header className="molstar-head">
          <span className="molstar-head-name">{name}</span>
          <span className="molstar-head-meta">{badge}</span>
          <button
            aria-label={TEXT.molstar.close}
            className="molstar-close"
            onClick={() => onExpand(false)}
            title={TEXT.molstar.close}
            type="button"
          >
            ✕
          </button>
        </header>
      ) : null}
      <div className="molstar-canvas" ref={hostRef} />
      {expanded ? null : <span className="molstar-badge">{badge}</span>}
      {status === "ready" ? null : (
        <div className="molstar-status">
          {status === "loading" ? TEXT.molstar.loading : (message ?? TEXT.molstar.initFailed)}
        </div>
      )}
    </div>
  );
}

/** Put the plugin into the layout the box is currently in. */
function applyLayout(plugin: PluginUIContext, expanded: boolean): void {
  try {
    PluginCommands.Layout.Update(plugin, { state: expanded ? FULL_LAYOUT : COMPACT_LAYOUT });
  } catch {
    /* The plugin can be mid-disposal; the layout it last had is the one it
       goes away with. */
  }
}

/** The atom count of the loaded structure, which is what the badge reports.
 *  Read from Mol* rather than counted from the file: a crystal is counted
 *  after its symmetry expansion, and the two numbers differ. */
function atomsOf(plugin: PluginUIContext): number | undefined {
  return plugin.managers.structure.hierarchy.current.structures[0]?.cell.obj?.data?.elementCount;
}

/**
 * Mol* sizes its canvas from the element it was given, and that element reaches
 * its final size a layout pass after the plugin mounts. Settling twice — once
 * on the next frame, once after the panel's own layout has settled — is what
 * keeps the viewport from drawing at the wrong size until something else
 * happens to resize it.
 */
function settle(plugin: PluginUIContext): void {
  const once = () => {
    try {
      plugin.canvas3d?.handleResize();
      plugin.canvas3d?.setProps({
        renderer: { backgroundColor: Color(0xffffff) },
        transparentBackground: false,
      });
      plugin.managers.camera.reset();
      plugin.canvas3d?.requestDraw();
    } catch {
      /* The plugin can be mid-disposal; a missed settle is not an error. */
    }
  };
  requestAnimationFrame(once);
  setTimeout(once, 250);
}

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

import { useEffect, useRef, useState } from "react";

import "molstar/build/viewer/molstar.css";
import { Structure } from "molstar/lib/mol-model/structure";
import { alignAndSuperpose } from "molstar/lib/mol-model/structure/structure/util/superposition";
import { createPluginUI } from "molstar/lib/mol-plugin-ui";
import type { PluginUIContext } from "molstar/lib/mol-plugin-ui/context";
import { renderReact18 } from "molstar/lib/mol-plugin-ui/react18";
import { DefaultPluginUISpec } from "molstar/lib/mol-plugin-ui/spec";
import { StateTransforms } from "molstar/lib/mol-plugin-state/transforms";
import { Color } from "molstar/lib/mol-util/color";

import { useLocale } from "./i18n/index.js";
import { cifTrajectoryFormat, type StructureFormat } from "./molecular.js";

const MOLSTAR_FORMAT: Record<StructureFormat, string> = {
  cif: "mmcif",
  mol2: "mol2",
  pdb: "pdb",
  sdf: "sdf",
  xyz: "xyz",
};

export interface Candidate { content: string; format: StructureFormat; name?: string }

/**
 * Floating window that mounts a full Mol* plugin (sequence panel, superposition,
 * representations, measurements …). Loads one or more structures; when more than
 * one is given, the rest are aligned and superposed onto the first via Mol*'s
 * built-in Kabsch superposition (alignAndSuperpose). Lazily imported so the heavy
 * Mol* bundle is only fetched when opened.
 */
export default function MolstarWindow({ structures, onClose }: {
  structures: Candidate[];
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const pluginRef = useRef<PluginUIContext | null>(null);
  const [status, setStatus] = useState<"error" | "loading" | "ready">("loading");
  const [message, setMessage] = useState<string>();
  const [rmsd, setRmsd] = useState<number>();
  const { t } = useLocale();

  const title = structures.length > 1
    ? `${structures[0]?.name ?? "A"} + ${structures.length - 1} superposed`
    : structures[0]?.name ?? "3D structure";

  useEffect(() => {
    let disposed = false;
    setStatus("loading");
    setMessage(undefined);
    setRmsd(undefined);
    void (async () => {
      try {
        const host = hostRef.current;
        if (!host) return;
        const spec = DefaultPluginUISpec();
        spec.layout = {
          initial: {
            isExpanded: false,
            showControls: true,
            controlsDisplay: "reactive",
            regionState: { left: "full", right: "full", top: "full", bottom: "collapsed" },
          },
        };
        const plugin = await createPluginUI({ target: host, render: renderReact18, spec });
        if (disposed) { plugin.dispose(); return; }
        pluginRef.current = plugin;
        for (const structure of structures) {
          const data = await plugin.builders.data.rawData({ data: structure.content });
          // A .cif is either mmCIF or crystallographic CIF core; each needs its own parser.
          const format = structure.format === "cif" ? cifTrajectoryFormat(structure.content) : MOLSTAR_FORMAT[structure.format];
          const trajectory = await plugin.builders.structure.parseTrajectory(data, format);
          // A crystal is only readable as its unit cell: the default preset draws the
          // asymmetric unit alone (two atoms for rock salt) and hides the cell box.
          // Mol*'s "unitcell" preset expands the symmetry and draws the cell; when the
          // file has no usable symmetry it declines, and we still show the cell box.
          // Mol*'s typings only expose the two-argument form of applyPreset here, so go
          // through a minimal structural type to pass preset params.
          const hierarchy = plugin.builders.structure.hierarchy as unknown as {
            applyPreset(parent: unknown, preset: string, params?: unknown): Promise<unknown> | undefined;
          };
          const applied = format === "cifCore" ? await hierarchy.applyPreset(trajectory, "unitcell") : undefined;
          if (!applied) await hierarchy.applyPreset(trajectory, "default", format === "cifCore" ? { showUnitcell: true } : undefined);
          if (disposed) return;
        }
        if (structures.length > 1) await superpose(plugin, setRmsd);
        if (disposed) return;
        setStatus("ready");
        const settle = () => {
          try {
            plugin.canvas3d?.handleResize();
            plugin.canvas3d?.setProps({ renderer: { backgroundColor: Color(0xffffff) }, transparentBackground: false });
            plugin.managers.camera.reset();
            plugin.canvas3d?.requestDraw();
          } catch { /* noop */ }
        };
        requestAnimationFrame(settle);
        setTimeout(settle, 250);
      } catch (error) {
        if (disposed) return;
        setStatus("error");
        setMessage(error instanceof Error ? error.message : t("molstar.renderFailed"));
      }
    })();
    return () => {
      disposed = true;
      try { pluginRef.current?.dispose(); } catch { /* already gone */ }
      pluginRef.current = null;
    };
    // structures is rebuilt each render; key by their content so we only reload on real change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structures.map((structure) => structure.content).join("\u0000")]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return <div className="molstar-backdrop" onClick={onClose} role="presentation">
    <div aria-label={t("molstar.viewerAria", { title })} className="molstar-window" onClick={(event) => event.stopPropagation()} role="dialog">
      <div className="molstar-window-head">
        <strong>Mol* · {title}{rmsd !== undefined ? ` · RMSD ${rmsd.toFixed(2)} Å` : ""}</strong>
        <button aria-label={t("molstar.closeViewer")} onClick={onClose} type="button">✕</button>
      </div>
      <div className="molstar-host" ref={hostRef} />
      {status !== "ready" ? <div className="molstar-status">{status === "loading" ? t("molstar.loading") : message ?? t("molstar.unableToRender")}</div> : null}
    </div>
  </div>;
}

// Align every structure after the first onto the first, applying the resulting
// transform so the representations move (the official Mol* superposition flow).
async function superpose(plugin: PluginUIContext, onRmsd: (value: number) => void): Promise<void> {
  const dataOf = (cell: unknown): unknown => (cell as { obj?: { data?: unknown } }).obj?.data;
  const structures = plugin.managers.structure.hierarchy.current.structures;
  if (structures.length < 2) return;
  const reference = dataOf(structures[0]!.cell);
  if (!reference) return;
  for (let index = 1; index < structures.length; index += 1) {
    const mobile = dataOf(structures[index]!.cell);
    if (!mobile) continue;
    try {
      const [result] = alignAndSuperpose([Structure.toStructureElementLoci(reference), Structure.toStructureElementLoci(mobile)]);
      if (!result) continue;
      const tree = plugin.state.data.build()
        .to(structures[index]!.cell)
        .insert(StateTransforms.Model.TransformStructureConformation, { transform: { name: "matrix", params: { data: result.bTransform, transpose: false } } });
      await plugin.runTask(plugin.state.data.updateTree(tree));
      onRmsd(result.rmsd);
    } catch {
      // Structures without a comparable polymer sequence (small molecules,
      // crystals) can't be aligned — leave them as loaded rather than failing.
    }
  }
}

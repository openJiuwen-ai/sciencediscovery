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

import { useEffect, useState } from "react";

import type { ApiClient } from "../../api/client.js";
import { getSandboxNetwork, updateSandboxNetwork } from "../../api/settings.js";
import type { SandboxNetworkMode, SandboxNetworkSettings } from "../../api/types.js";
import { domainEntries } from "../../app/settings-format.js";
import type { ConfirmRequest, Toast } from "../../app/use-workspace.js";
import { useLoaded } from "../../app/use-loaded.js";
import { TEXT } from "../../text.js";
import { Group, LoadGate, Pills, Row } from "./rows.js";

interface Props {
  client: ApiClient;
  onConfirm: (request: ConfirmRequest) => void;
  /** Saving has nothing else to show for itself: the controls fall back to
   *  their saved values and the button goes quiet again, which is exactly the
   *  same picture as before the press. The toast is what says it landed. */
  toast: (message: string, tone?: Toast["tone"]) => void;
}

/** Ordered from the safest to the widest, which is also the order the warning
 *  escalates in; the current value is never the first thing you see chosen by
 *  accident. */
const MODES: SandboxNetworkMode[] = ["none", "domain-allowlist", "open"];

/** Read when the select renders, not when this module loads: `TEXT` follows
 *  the interface language, and a captured label would not. */
function modeLabel(mode: SandboxNetworkMode): string {
  const sandbox = TEXT.settings.network.sandbox;
  if (mode === "open") return sandbox.modeOpen;
  if (mode === "domain-allowlist") return sandbox.modeAllowlist;
  return sandbox.modeNone;
}

/**
 * 设置 › 网络.
 *
 * One subject: whether code inside the sandbox may leave the machine, and — in
 * the allowlist mode — which domains it may reach. The private-address switch
 * and the egress route are still absent; the allowlist is the part of the
 * policy this page offers.
 *
 * 无网络 and 开放网络 are written on the press that picks them: there is
 * nothing to stage, so a save button would only be a step between the choice
 * and its effect. Switching to 开放网络 still asks first — that confirmation is
 * the press's own consequence, not a second save — and every write rotates the
 * permission epoch and drops every persistent kernel, so the toast says it
 * landed.
 *
 * 域名白名单 is the exception, and the reason the box carries a 保存 of its
 * own. The service refuses an allowlist with no domains, and the box that takes
 * them is disabled until that mode is picked — so picking the mode only stages
 * it, and 保存 writes the mode and the domains in one request.
 */
export function NetworkSettings({ client, onConfirm, toast }: Props) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  /** The allowlist is the one part of the page with a draft: its mode and its
   *  domains are written together, so neither can be read straight off the
   *  server value while they are being edited. Both are reset whenever a
   *  confirmed value arrives. */
  const [drafts, setDrafts] = useState<{ domains: string; mode: SandboxNetworkMode }>();

  const loaded = useLoaded<SandboxNetworkSettings>(async () => getSandboxNetwork(client));

  /** The value the controls show: the server's. `undefined` only while the
   *  read is in flight. */
  const current = loaded.value;

  useEffect(() => {
    if (current === undefined) return;
    setDrafts({ domains: current.allowedDomains.join("\n"), mode: current.mode });
  }, [current]);

  const mode = drafts?.mode ?? current?.mode;
  const allowlist = mode === "domain-allowlist";

  const write = async (body: SandboxNetworkSettings): Promise<boolean> => {
    setBusy(true);
    setFailure(undefined);
    try {
      await updateSandboxNetwork(client, body);
      toast(TEXT.settings.network.sandbox.saved, "info");
      loaded.reload();
      return true;
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const choose = async (next: SandboxNetworkMode) => {
    if (current === undefined || busy || mode === next) return;
    if (next === "domain-allowlist") {
      // Nothing to write yet: the service refuses an allowlist with no
      // domains, and the box that takes them is disabled until this mode is
      // chosen. The 保存 under the box writes both together.
      setDrafts({ domains: drafts?.domains ?? current.allowedDomains.join("\n"), mode: next });
      setFailure(undefined);
      return;
    }
    // The pill and the box follow the press at once; a failed write puts them
    // back on the policy the server still holds. A mode that does not use the
    // allowlist must not carry one — the service rejects 开放网络 with domains
    // attached.
    setDrafts({ domains: "", mode: next });
    if (await write({ ...current, allowedDomains: [], mode: next })) return;
    setDrafts({ domains: current.allowedDomains.join("\n"), mode: current.mode });
  };

  const saveDomains = async () => {
    if (current === undefined || busy || !allowlist) return;
    const allowedDomains = domainEntries(drafts?.domains ?? "");
    if (allowedDomains.length === 0) {
      setFailure(TEXT.settings.network.sandbox.emptyDomains);
      return;
    }
    // A refused write keeps the draft: the entry is what has to be corrected,
    // and reloading would take it away.
    await write({ ...current, allowedDomains, mode: "domain-allowlist" });
  };

  return (
    <LoadGate loaded={loaded}>
      {() => (
        <>
          {current ? (
            <Group heading={TEXT.settings.network.sandbox.heading}>
              <Row hint={TEXT.settings.network.sandbox.scope} title={TEXT.settings.network.sandbox.mode}>
                <Pills
                  label={TEXT.settings.network.sandbox.mode}
                  onChange={(value) => {
                    const next = value as SandboxNetworkMode;
                    if (next === "open") {
                      onConfirm({
                        accept: TEXT.settings.network.sandbox.modeOpen,
                        body: TEXT.settings.network.sandbox.modeOpenWarning,
                        eyebrow: TEXT.settings.network.sandbox.heading,
                        onAccept: () => choose(next),
                        title: TEXT.settings.network.sandbox.modeOpen,
                      });
                      return;
                    }
                    void choose(next);
                  }}
                  options={MODES.map((option) => ({ label: modeLabel(option), value: option }))}
                  value={mode ?? current.mode}
                />
              </Row>

              <Row title={TEXT.settings.network.sandbox.domains} tone="stack">
                <div className="allowlist-editor">
                  <textarea
                    aria-label={TEXT.settings.network.sandbox.domains}
                    className="field-textarea is-code"
                    disabled={!allowlist || busy}
                    onChange={(event) => {
                      setDrafts({ domains: event.target.value, mode: "domain-allowlist" });
                      setFailure(undefined);
                    }}
                    placeholder={TEXT.settings.network.sandbox.domainsPlaceholder}
                    rows={5}
                    spellCheck={false}
                    value={allowlist ? (drafts?.domains ?? "") : ""}
                  />
                  <div className="allowlist-actions">
                    <button
                      className="secondary-button"
                      disabled={!allowlist || busy}
                      onClick={() => void saveDomains()}
                      type="button"
                    >
                      {TEXT.settings.network.sandbox.saveDomains}
                    </button>
                  </div>
                </div>
              </Row>
            </Group>
          ) : null}

          {failure ? <small className="row-note is-error">{failure}</small> : null}
        </>
      )}
    </LoadGate>
  );
}

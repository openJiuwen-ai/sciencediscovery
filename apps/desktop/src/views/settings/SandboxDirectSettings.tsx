// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd.
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

import { useSeatbeltStatus, useShellDirectExecution } from "../../app/shell-bridge.js";
import { TEXT } from "../../text.js";
import { Group, Row, Switch } from "./rows.js";

/**
 * 设置 › 连接 › 沙箱 (the sandbox block, [mac-direct] relocation).
 *
 * [mac-direct] The installation-level opt-in for direct candidate
 * execution lives here — but only where it exists. The block asks the
 * shell first (`useShellDirectExecution`): a darwin shell answers
 * `available: true` and the switch renders; a Windows shell hard-sets the
 * env flag this row would toggle, and a plain browser has no shell at all,
 * so both hide the section rather than show a switch that does nothing.
 * The hint carries the whole warning — what runs, with whose access, and
 * that each run still confirms — because the switch is the only place the
 * contract is spelled out before the first confirmation dialog.
 *
 * The block sits in the 沙箱网络 page (user call 2026-11-25: everything
 * that governs the sandbox belongs behind one 「沙箱」 entrance — the
 * network rows below it regulate what code inside the sandbox may reach,
 * this block decides whether the sandbox runs at all). The scope
 * difference stands: the network rows are a workspace-level policy (saved
 * through the API, per-workspace), while this switch is an
 * installation-level file. [heading-split] This Group carries its own
 * heading (directExecution.heading, 沙箱/Sandbox) rather than reusing the
 * page-level 沙箱网络 one: two Groups on one page need two names — 「沙箱」
 * for whether the sandbox runs at all, 「沙箱网络」 for what code inside it
 * may reach — or the page would draw the same section rule twice with the
 * same label (round 17 review).
 *
 * [U5c] The status row — the ONE place sandbox health is shown
 * (owner decision 2026-11-23: 初始化不拦截不提示，沙箱监测只在
 * 设置).
 */
export function SandboxDirectSettings() {
  const direct = useShellDirectExecution();
  const { status: sandbox } = useSeatbeltStatus();

  return direct.available ? (
    <Group heading={TEXT.settings.network.sandbox.directExecution.heading}>
      {/* [U5c] The status row. [F16] The row's state is derived from BOTH
          inputs — the probe verdict AND the session's effective mode —
          because a row that reads only the probe would claim "sandboxed"
          on an opted-in install whose probe passed, which is the opposite
          of the truth. [F18] The effective mode is the spawn-time
          `directActive` snapshot, not the persisted switch: right after
          a mid-session toggle the live stack is still in its old mode,
          and the row must keep stating the old mode while the switch's
          hint says a restart applies the change. [F21] The FAILED
          verdict wins the branch order: a session whose probe failed
          never renders the green "sandboxed" sentence, whatever
          directActive says — directActive is spawn-time bookkeeping, the
          verdict is the fact the user needs on the row (an
          attach-to-external-stack session may not have the flag set even
          though its env pair is direct). [F26] modeKnown:false means this
          session ADOPTED an already-running stack — its mode is inferred
          from this shell's inputs, not the survivor's env — so the
          ok/optedOut sentences must not assert; the row says "attached,
          not verified" instead. The failed verdict still asserts (the
          probe is this session's own fact, independent of whose process
          runs). */}
      {sandbox ? (
        sandbox.kind === "failed" ? (
          <Row
            hint={`${TEXT.settings.network.sandbox.status.failed} ${TEXT.settings.network.sandbox.status.failCause[sandbox.detail.failCode] ?? ""}`.trim()}
            tone="status"
            title={TEXT.settings.network.sandbox.status.field}
          >
            {/* [F12] The probe's own reason + the diagnostic commands ride
                the dot's tooltip — the cause sentence in the hint is
                localized; this is the raw detail. */}
            <span
              className="sandbox-status-dot"
              data-kind="failed"
              title={[sandbox.reason, ...sandbox.diagnostics].join("\n")}
              aria-hidden="true"
            />
          </Row>
        ) : sandbox.modeKnown === false ? (
          <Row
            hint={TEXT.settings.network.sandbox.status.attached}
            tone="status"
            title={TEXT.settings.network.sandbox.status.field}
          >
            <span className="sandbox-status-dot" data-kind="attached" aria-hidden="true" />
          </Row>
        ) : sandbox.directActive ? (
          <Row
            hint={direct.enabled
              ? TEXT.settings.network.sandbox.status.optedOut
              : TEXT.settings.network.sandbox.status.optedOutSwitchOff}
            tone="status"
            title={TEXT.settings.network.sandbox.status.field}
          >
            <span className="sandbox-status-dot" data-kind="opted-out" aria-hidden="true" />
          </Row>
        ) : (
          <Row
            hint={TEXT.settings.network.sandbox.status.ok}
            tone="status"
            title={TEXT.settings.network.sandbox.status.field}
          >
            <span className="sandbox-status-dot" data-kind="ok" aria-hidden="true" />
          </Row>
        )
      ) : null}
      {/* [hint-split] The lead sentence stays in the Row's hint; the full
          blast radius moves into a native <details> block below it. Two
          readers, two layers: someone deciding reads the expanded list
          once, someone passing by pays only one sentence. <details> keeps
          this state-free (no React state, no focus management) and
          accessible by default; the copy red line (review 2026-11-23) is
          preserved verbatim — every point of the old single-paragraph hint
          is one bullet in hintDetails, and the [U5c] copy tests assert
          over hint + hintDetails combined.
          [F29] The restart clause is the one point that stays in the lead
          hint instead: flipping the switch gives no immediate feedback
          (the status row keeps stating the spawn-time mode until the
          next spawn), so that clause is the only thing that explains the
          window right after the flip — the one moment it matters, it
          must be always visible (review 2026-11-24). */}
      <Row
        hint={TEXT.settings.network.sandbox.directExecution.hint}
        title={TEXT.settings.network.sandbox.directExecution.field}
      >
        <Switch
          label={TEXT.settings.network.sandbox.directExecution.field}
          onChange={direct.setEnabled}
          value={direct.enabled}
        />
      </Row>
      <details className="direct-execution-details">
        <summary>
          <span className="direct-execution-details-show">{TEXT.settings.network.sandbox.directExecution.showDetails}</span>
          <span className="direct-execution-details-hide">{TEXT.settings.network.sandbox.directExecution.hideDetails}</span>
        </summary>
        <ul>
          {TEXT.settings.network.sandbox.directExecution.hintDetails.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>
    </Group>
  ) : null;
}

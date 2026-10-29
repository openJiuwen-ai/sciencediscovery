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

/**
 * 角标与引导话术的单一来源（0.B1 §4/§6）：API / UI / Electron 壳共用，
 * 禁止各处自写文案。
 */
import type { ExecutionBadge, ExecutionProvider } from "./types.js";

/** 统一不可用话术（0.B1 §6 冻结文案） */
export function providerUnusableMessage(provider: ExecutionProvider): string {
  switch (provider) {
    case "wsl":
      return "本地沙箱引擎插件未安装——安装后获得 🔒 沙箱执行";
    case "remote":
      return "远程执行未配置——设置页填写 SSH 主机";
    case "windows-direct":
      return "Windows 直跑执行当前不可用";
  }
}

/** 角标标签（0.B1 §4：🔒 / ⚠️ / 🌐） */
export function providerBadgeLabel(badge: ExecutionBadge): string {
  switch (badge) {
    case "sandboxed":
      return "🔒 沙箱执行中";
    case "direct":
      return "⚠️ Windows 直跑（无沙箱隔离）";
    case "remote":
      return "🌐 远程执行中";
  }
}

/**
 * 无沙箱时拒绝 always_allow 的 409 话术（0.B1 §5 会话创建/切换两入口
 * 共用，API 只引这一句，不自写文案）。
 */
export function unsandboxedApprovalModeMessage(badge: ExecutionBadge): string {
  return `当前执行为「${providerBadgeLabel(badge)}」，无沙箱隔离时不允许 always_allow 审批模式。`
    + "请安装「本地沙箱引擎」插件获得 🔒 沙箱执行，或改用 ask_for_dangerous（危险操作需审批）。";
}

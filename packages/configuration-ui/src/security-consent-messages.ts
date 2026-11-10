// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { SecurityConsentCapability } from "./compatibility.js";

export const securityConsentMessages = {
  en: {
    "security.network": "I have reviewed the deployment-wide access changes and possible loss of persistent kernel/shell state.",
    "security.approval_mode": "I have reviewed this session’s future approval policy, possible loss of persistent kernel/shell state, and continuation of its bound original task. Existing permission cards must be handled separately.",
    "security.default_approval": "I reviewed the tool approval policy for newly created sessions; existing sessions and pending tools will not change.",
    "security.automatic_configuration": "I authorize supported low-risk connector proposals in this Session to use the cancellation window. Tool execution, credentials, security settings and explicit configuration choices still require their own authorization.",
    "proxy.default": "I have reviewed the new default route for inheriting outbound traffic, including later requests that carry credentials.",
  },
  zh: {
    "security.network": "我已核对整个部署的访问权限变化，以及持久 kernel／shell 内存可能丢失的影响。",
    "security.approval_mode": "我已核对当前会话后续动作的审批策略、持久 kernel／shell 内存可能丢失，以及已绑定原任务可能接续的影响。现有权限卡须单独处理。",
    "security.default_approval": "我已核对新建会话的工具授权默认值；现有会话和待批准工具不变。",
    "security.automatic_configuration": "我允许本会话支持的低风险连接器提案使用取消窗口。工具执行、凭据、安全设置以及需明确选择的配置仍须分别授权。",
    "proxy.default": "我已核对继承部署默认的出站流量将使用的新路由，包括后续携带凭据的请求。",
  },
} satisfies Record<"en" | "zh", Record<SecurityConsentCapability, string>>;

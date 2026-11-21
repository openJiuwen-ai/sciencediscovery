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
 * Admin console.
 *
 * A static module: all authority lives in the HTTP endpoints, and this file only
 * decides what to draw. The session cookie is HttpOnly and never read here.
 */

const root = document.getElementById("app");

const state = {
  admin: null,
  view: "overview",
  overview: null,
  users: { page: 1, pageSize: 20, q: "", status: "", online: "", sort: "recent", order: "desc", total: 0, items: [] },
  detail: null,
  audit: [],
  busy: false,
};

const STATUS_LABEL = { 0: "正常", 1: "受限", 2: "冻结", 3: "注销中" };

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

function credits(milli) {
  const value = Number(milli ?? 0) / 1000;
  return value.toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function when(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { hour12: false });
}

let toastTimer;
function toast(message, kind = "info") {
  let element = document.querySelector(".toast");
  if (!element) {
    element = document.createElement("div");
    element.className = "toast";
    document.body.appendChild(element);
  }
  element.textContent = message;
  element.className = `toast show ${kind === "error" ? "error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.className = "toast"; }, 2600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json" },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/v1/admin/auth/")) {
      state.admin = null;
      renderLogin();
    }
    const error = new Error(payload?.error?.message || payload?.error?.code || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

/* -------------------------------------------------------------- login view */

function renderLogin(errorText = "") {
  root.innerHTML = `
    <div class="login">
      <form class="login-card" id="login-form">
        <h1>ScienceDiscovery</h1>
        <p class="hint">用户运营后台 · 账号登录</p>
        <div class="field">
          <label for="username">管理员账号</label>
          <input id="username" name="username" autocomplete="username" required />
        </div>
        <div class="field">
          <label for="password">密码</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required />
        </div>
        <button class="primary" type="submit">进入后台</button>
        <div class="error" id="login-error">${esc(errorText)}</div>
      </form>
    </div>`;

  const form = document.getElementById("login-form");
  const error = document.getElementById("login-error");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.busy) return;
    const button = form.querySelector("button.primary");
    state.busy = true;
    button.disabled = true;
    try {
      const result = await api("/v1/admin/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: form.username.value, password: form.password.value }),
      });
      state.admin = result.admin;
      await startShell();
    } catch (failure) {
      error.textContent = failure.message;
    } finally {
      state.busy = false;
      button.disabled = false;
    }
  });
}

/* -------------------------------------------------------------- shell */

async function startShell() {
  root.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">ScienceDiscovery<small>用户运营后台</small></div>
        <button data-view="overview">总览</button>
        <button data-view="users">用户</button>
        <button data-view="audit">审计日志</button>
        <div class="spacer"></div>
        <div class="who">
          ${esc(state.admin.username)} · 角色 ${state.admin.role}
          <button id="sign-out">退出登录</button>
        </div>
      </aside>
      <main class="main" id="main"></main>
    </div>
    <div class="toast"></div>`;

  root.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => go(button.dataset.view));
  });
  document.getElementById("sign-out").addEventListener("click", async () => {
    await api("/v1/admin/auth/logout", { method: "POST" }).catch(() => undefined);
    state.admin = null;
    renderLogin();
  });
  await go("overview");
}

function highlight(view) {
  root.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
}

async function go(view) {
  state.view = view;
  highlight(view);
  const main = document.getElementById("main");
  main.innerHTML = `<div class="page-head"><h2>加载中…</h2></div>`;
  try {
    if (view === "overview") await renderOverview(main);
    else if (view === "users") await renderUsers(main);
    else if (view === "audit") await renderAudit(main);
    else if (view === "detail") await renderDetail(main);
  } catch (error) {
    main.innerHTML = `<div class="page-head"><h2>加载失败</h2><span>${esc(error.message)}</span></div>`;
  }
}

/* -------------------------------------------------------------- overview */

async function renderOverview(main) {
  const data = await api("/v1/admin/overview");
  state.overview = data;
  main.innerHTML = `
    <div class="page-head"><h2>总览</h2><span>更新于 ${esc(when(data.generatedAt))}</span></div>
    <div class="cards">
      <div class="card"><div class="label">用户总数</div><div class="value">${data.totalUsers}</div></div>
      <div class="card"><div class="label">今日新增</div><div class="value">${data.newUsersToday}</div></div>
      <div class="card"><div class="label">今日活跃</div><div class="value">${data.activeToday}</div></div>
      <div class="card"><div class="label">当前在线会话</div><div class="value">${data.onlineSessions}</div></div>
      <div class="card"><div class="label">今日消耗积分</div><div class="value">${Number(data.spentToday ?? 0).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}</div></div>
      <div class="card"><div class="label">冻结账号</div><div class="value">${data.frozenUsers}</div></div>
    </div>
    <div class="panel">
      <div class="body" style="padding:16px;color:var(--muted)">
        在线口径：最近 5 分钟内有心跳或请求的会话；用户会话明细可在「用户」页进入单个账号查看并强制下线。
      </div>
    </div>`;
}

/* -------------------------------------------------------------- users */

function userQuery() {
  const params = new URLSearchParams({ page: String(state.users.page), pageSize: String(state.users.pageSize) });
  if (state.users.q) params.set("q", state.users.q);
  if (state.users.status !== "") params.set("status", state.users.status);
  if (state.users.online !== "") params.set("online", state.users.online);
  params.set("sort", state.users.sort);
  params.set("order", state.users.order);
  return params.toString();
}

async function renderUsers(main) {
  const data = await api(`/v1/admin/users?${userQuery()}`);
  state.users.items = data.items;
  state.users.total = data.total;
  const rows = data.items.map((user) => `
    <tr data-user="${user.id}" style="cursor:pointer">
      <td>
        <div>${esc(user.displayName || "未命名")}</div>
        <div style="color:var(--muted);font-size:12px">#${user.id} · ${esc(user.openidTail)}</div>
      </td>
      <td class="num">${credits(user.balance)}</td>
      <td class="num">${credits(user.totalSpent)}</td>
      <td class="num">${credits(user.totalEarned)}</td>
      <td>${user.status === 0 ? "正常" : `<span class="badge frozen">${esc(STATUS_LABEL[user.status] ?? user.status)}</span>`}</td>
      <td><span class="badge ${user.online ? "online" : "offline"}">${user.online ? "在线" : "离线"}</span></td>
      <td>${esc(when(user.lastSeenAt || user.lastLoginAt))}</td>
      <td>${esc(when(user.createdAt))}</td>
    </tr>`).join("");

  main.innerHTML = `
    <div class="page-head"><h2>用户</h2><span>共 ${data.total} 个账号</span></div>
    <div class="panel">
      <div class="toolbar">
        <input type="search" id="q" placeholder="搜索昵称 / openid / 邮箱" value="${esc(state.users.q)}" />
        <select id="status">
          <option value="">全部状态</option>
          <option value="0">正常</option>
          <option value="1">受限</option>
          <option value="2">冻结</option>
        </select>
        <select id="online">
          <option value="">全部在线状态</option>
          <option value="1">仅在线</option>
          <option value="0">仅离线</option>
        </select>
        <select id="sort">
          <option value="recent">按最近登录</option>
          <option value="id">按注册顺序</option>
          <option value="balance">按积分余额</option>
          <option value="spent">按累计消耗</option>
        </select>
        <button id="order">${state.users.order === "desc" ? "降序" : "升序"}</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>用户</th><th class="num">余额</th><th class="num">累计消耗</th><th class="num">累计获得</th>
            <th>状态</th><th>在线</th><th>最近活跃</th><th>注册时间</th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="8" class="empty">没有匹配的账号</td></tr>`}</tbody>
      </table>
      <div class="pager">
        <button id="prev" ${state.users.page <= 1 ? "disabled" : ""}>上一页</button>
        <span>第 ${state.users.page} 页 / 共 ${Math.max(Math.ceil(data.total / state.users.pageSize), 1)} 页</span>
        <button id="next" ${state.users.page * state.users.pageSize >= data.total ? "disabled" : ""}>下一页</button>
      </div>
    </div>`;

  document.getElementById("status").value = state.users.status;
  document.getElementById("online").value = state.users.online;
  document.getElementById("sort").value = state.users.sort;

  document.getElementById("q").addEventListener("change", (event) => { state.users.q = event.target.value.trim(); state.users.page = 1; go("users"); });
  document.getElementById("status").addEventListener("change", (event) => { state.users.status = event.target.value; state.users.page = 1; go("users"); });
  document.getElementById("online").addEventListener("change", (event) => { state.users.online = event.target.value; state.users.page = 1; go("users"); });
  document.getElementById("sort").addEventListener("change", (event) => { state.users.sort = event.target.value; state.users.page = 1; go("users"); });
  document.getElementById("order").addEventListener("click", () => { state.users.order = state.users.order === "desc" ? "asc" : "desc"; go("users"); });
  document.getElementById("prev").addEventListener("click", () => { state.users.page -= 1; go("users"); });
  document.getElementById("next").addEventListener("click", () => { state.users.page += 1; go("users"); });
  main.querySelectorAll("[data-user]").forEach((row) => {
    row.addEventListener("click", () => { state.detail = Number(row.dataset.user); go("detail"); });
  });
}

/* -------------------------------------------------------------- detail */

async function renderDetail(main) {
  const data = await api(`/v1/admin/users/${state.detail}`);
  const { user, credit } = data;
  const sessions = data.sessions.map((session) => `
    <tr>
      <td>${esc(session.platformLabel)}${session.deviceLabel ? ` · ${esc(session.deviceLabel)}` : ""}</td>
      <td><span class="badge ${session.presence}">${session.presence === "online" ? "在线" : session.presence === "recent" ? "最近活跃" : session.presence === "revoked" ? "已下线" : "离线"}</span></td>
      <td>${esc(session.ip || "—")}</td>
      <td>${esc(when(session.lastSeenAt))}</td>
      <td>${session.revokedAt ? esc(session.revokedReason || "已吊销") : `<button data-revoke="${esc(session.id)}">强制下线</button>`}</td>
    </tr>`).join("");
  const ledger = data.ledger.map((row) => `
    <tr>
      <td>${esc(when(row.createdAt))}</td>
      <td>${esc(row.bizType)}${row.remark ? `<div style="color:var(--muted);font-size:12px">${esc(row.remark)}</div>` : ""}</td>
      <td class="num" style="color:${row.delta < 0 ? "var(--danger)" : "var(--ok)"}">${row.delta > 0 ? "+" : ""}${credits(row.delta)}</td>
      <td class="num">${credits(row.balanceAfter)}</td>
    </tr>`).join("");
  const usage = data.usage.map((row) => `
    <tr><td>${esc(row.day)}</td><td class="num">${row.requests}</td><td class="num">${credits(row.creditsUsed)}</td><td class="num">${row.inputTokens + row.outputTokens}</td></tr>`).join("");

  main.innerHTML = `
    <div class="detail-head">
      <div>
        <h2>${esc(user.displayName || "未命名用户")}</h2>
        <div class="meta">#${user.id} · openid …${esc(user.openidTail)} · 注册于 ${esc(when(user.createdAt))}</div>
      </div>
      <button id="back">返回列表</button>
    </div>
    <div class="cards">
      <div class="card"><div class="label">积分余额</div><div class="value">${credits(credit.balance)}</div></div>
      <div class="card"><div class="label">累计消耗</div><div class="value">${credits(credit.totalSpent)}</div></div>
      <div class="card"><div class="label">累计获得</div><div class="value">${credits(credit.totalEarned)}</div></div>
      <div class="card"><div class="label">在线会话</div><div class="value">${data.onlineSessions}<small> / ${data.activeSessions} 活跃</small></div></div>
    </div>
    <div class="grid">
      <section class="section">
        <h3>账号</h3>
        <div class="body">
          <dl class="kv">
            <dt>状态</dt><dd>${user.status === 0 ? "正常" : esc(STATUS_LABEL[user.status] ?? user.status)}</dd>
            <dt>邮箱</dt><dd>${esc(user.email || "—")}</dd>
            <dt>最近登录</dt><dd>${esc(when(user.lastLoginAt))}</dd>
            <dt>积分更新</dt><dd>${esc(when(credit.updatedAt))}</dd>
          </dl>
          <div class="actions" style="margin-top:12px">
            <select id="status-select">
              <option value="0">正常</option>
              <option value="1">受限</option>
              <option value="2">冻结</option>
            </select>
            <button id="apply-status">更新状态</button>
          </div>
        </div>
      </section>
      <section class="section">
        <h3>积分调整</h3>
        <div class="body">
          <div class="actions">
            <input id="delta" type="number" step="0.01" placeholder="增减积分，可为负" style="width:160px" />
            <input id="reason" type="text" placeholder="原因（写入审计）" style="flex:1;min-width:140px" />
            <button class="accent" id="adjust">提交</button>
          </div>
          <p style="color:var(--muted);font-size:12px;margin:10px 0 0">调整与流水、审计在同一事务内完成，不会出现只加积分不记账的窗口。</p>
        </div>
      </section>
      <section class="section">
        <h3>会话与登录状态</h3>
        <div class="body" style="padding:0">
          <table>
            <thead><tr><th>设备</th><th>状态</th><th>IP</th><th>最近活跃</th><th>操作</th></tr></thead>
            <tbody>${sessions || `<tr><td colspan="5" class="empty">暂无会话</td></tr>`}</tbody>
          </table>
        </div>
      </section>
      <section class="section">
        <h3>近 30 天用量</h3>
        <div class="body" style="padding:0">
          <table>
            <thead><tr><th>日期</th><th class="num">请求</th><th class="num">消耗积分</th><th class="num">Token</th></tr></thead>
            <tbody>${usage || `<tr><td colspan="4" class="empty">暂无用量</td></tr>`}</tbody>
          </table>
        </div>
      </section>
      <section class="section" style="grid-column:1/-1">
        <h3>积分流水（最近 20 条）</h3>
        <div class="body" style="padding:0">
          <table>
            <thead><tr><th>时间</th><th>类型</th><th class="num">变动</th><th class="num">余额</th></tr></thead>
            <tbody>${ledger || `<tr><td colspan="4" class="empty">暂无流水</td></tr>`}</tbody>
          </table>
        </div>
      </section>
    </div>`;

  document.getElementById("back").addEventListener("click", () => go("users"));
  document.getElementById("status-select").value = String(user.status === 3 ? 2 : user.status);

  document.getElementById("apply-status").addEventListener("click", async () => {
    try {
      await api(`/v1/admin/users/${user.id}/status`, { method: "POST", body: JSON.stringify({ status: Number(document.getElementById("status-select").value) }) });
      toast("状态已更新");
      await go("detail");
    } catch (error) {
      toast(error.message, "error");
    }
  });

  document.getElementById("adjust").addEventListener("click", async () => {
    const delta = Number(document.getElementById("delta").value);
    const reason = document.getElementById("reason").value.trim();
    if (!delta || !reason) return toast("请填写变动值与原因", "error");
    try {
      await api(`/v1/admin/users/${user.id}/credits/adjust`, { method: "POST", body: JSON.stringify({ deltaCredits: delta, reason }) });
      toast("积分已调整");
      await go("detail");
    } catch (error) {
      toast(error.message, "error");
    }
  });

  main.querySelectorAll("[data-revoke]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await api(`/v1/admin/users/${user.id}/sessions/${button.dataset.revoke}/revoke`, { method: "POST" });
        toast("会话已强制下线");
        await go("detail");
      } catch (error) {
        toast(error.message, "error");
      }
    });
  });
}

/* -------------------------------------------------------------- audit */

async function renderAudit(main) {
  const data = await api("/v1/admin/audit?limit=100");
  const rows = data.items.map((row) => `
    <tr>
      <td>${esc(when(row.createdAt))}</td>
      <td>${esc(row.adminUsername || `#${row.adminId}`)}</td>
      <td>${esc(row.action)}</td>
      <td>${esc(row.targetType || "")}${row.targetId ? ` #${esc(row.targetId)}` : ""}</td>
      <td style="white-space:normal;color:var(--muted);font-size:12px">${esc(row.detail ? JSON.stringify(row.detail) : "")}</td>
      <td>${esc(row.ip || "—")}</td>
    </tr>`).join("");
  main.innerHTML = `
    <div class="page-head"><h2>审计日志</h2><span>最近 100 条写操作</span></div>
    <div class="panel">
      <table>
        <thead><tr><th>时间</th><th>管理员</th><th>动作</th><th>对象</th><th>详情</th><th>IP</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="6" class="empty">暂无记录</td></tr>`}</tbody>
      </table>
    </div>`;
}

/* -------------------------------------------------------------- boot */

(async () => {
  try {
    const me = await api("/v1/admin/me");
    state.admin = me.admin;
    await startShell();
  } catch {
    renderLogin();
  }
})();

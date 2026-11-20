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

import {
  createAsset,
  decide,
  login,
  me,
  myAssets,
  reviewQueue,
  storeToken,
  uploadVersion,
} from "../api/client.js";

import type { JSX } from "react";
import type { Account as AccountUser, MyAsset, ReviewItem } from "../api/client.js";

const TEXT = {
  en: {
    account: "Account",
    approve: "Approve",
    assets: "My assets",
    back: "Back to hub",
    category: "Category (domain/subdomain)",
    changelog: "What changed",
    create: "Create asset",
    created: "Asset created. Upload a version next.",
    display: "Display name",
    file: "Package (.zip or .sdresearch)",
    kind: "Kind",
    login: "Sign in",
    logout: "Sign out",
    name: "Name (slug)",
    pending: "Pending review",
    reject: "Reject",
    review: "Review queue",
    summary: "Summary",
    upload: "Upload",
    version: "Version",
    visibility: "Visibility",
    wrong: "Sign-in failed",
  },
  zh: {
    account: "账号",
    approve: "通过",
    assets: "我的资产",
    back: "返回 Hub",
    category: "分类（domain/subdomain）",
    changelog: "变更说明",
    create: "创建资产",
    created: "资产已创建，接下来上传版本。",
    display: "显示名称",
    file: "包文件（.zip 或 .sdresearch）",
    kind: "类型",
    login: "登录",
    logout: "退出",
    name: "标识（slug）",
    pending: "待审核",
    reject: "驳回",
    review: "审核队列",
    summary: "简介",
    upload: "上传",
    version: "版本",
    visibility: "可见性",
    wrong: "登录失败",
  },
} as const;

type Copy = (typeof TEXT)["en"];

export function AccountView({ language, onClose }: { language: "en" | "zh"; onClose: () => void }): JSX.Element {
  const copy = TEXT[language] as Copy;
  const [user, setUser] = useState<AccountUser | null>(null);
  const [assets, setAssets] = useState<MyAsset[]>([]);
  const [queue, setQueue] = useState<ReviewItem[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [draft, setDraft] = useState({
    category: "",
    display_name: "",
    kind: "skill",
    name: "",
    summary: "",
    visibility: "public",
  });
  const [uploads, setUploads] = useState<Record<string, { changelog: string; file: File | null; version: string }>>({});

  async function refresh(current: AccountUser | null): Promise<void> {
    if (!current) return;
    setAssets(await myAssets());
    setQueue(current.role === "admin" ? await reviewQueue() : []);
  }

  useEffect(() => {
    void me().then(async (current) => {
      setUser(current);
      await refresh(current);
    });
  }, []);

  async function signIn(): Promise<void> {
    setError("");
    try {
      const current = await login(username, password);
      setUser(current);
      setPassword("");
      await refresh(current);
    } catch (caught) {
      setError(`${copy.wrong}: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }

  async function create(): Promise<void> {
    setError("");
    setNotice("");
    try {
      await createAsset({
        category: draft.category || undefined,
        display_name: draft.display_name,
        kind: draft.kind,
        name: draft.name,
        summary: draft.summary,
        visibility: draft.visibility as "private" | "public",
      });
      setNotice(copy.created);
      await refresh(user);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function uploadDraft(assetId: string) {
    return uploads[assetId] ?? { changelog: "", file: null, version: "" };
  }

  return (
    <div className="detail-wrap account">
      <button className="back" onClick={onClose} type="button">{copy.back}</button>
      <h1>{copy.account}</h1>
      {error ? <p className="empty">{error}</p> : null}
      {notice ? <p className="muted">{notice}</p> : null}

      {user === null ? (
        <section className="account-card">
          <label>{copy.login} <input onChange={(event) => setUsername(event.target.value)} value={username} /></label>
          <label>Password <input onChange={(event) => setPassword(event.target.value)} type="password" value={password} /></label>
          <button className="button" onClick={() => { void signIn(); }} type="button">{copy.login}</button>
        </section>
      ) : (
        <>
          <section className="account-card">
            <p>{user.display_name} · {user.role}</p>
            <button className="button button-ghost" onClick={() => { storeToken(""); setUser(null); setAssets([]); setQueue([]); }} type="button">{copy.logout}</button>
          </section>

          <section className="account-card">
            <h2>{copy.create}</h2>
            <label>{copy.kind}
              <select onChange={(event) => setDraft({ ...draft, kind: event.target.value })} value={draft.kind}>
                <option value="skill">skill</option>
                <option value="team">team</option>
                <option value="specialist">specialist</option>
                <option value="connector">connector</option>
                <option value="session">session</option>
              </select>
            </label>
            <label>{copy.name} <input onChange={(event) => setDraft({ ...draft, name: event.target.value })} value={draft.name} /></label>
            <label>{copy.display} <input onChange={(event) => setDraft({ ...draft, display_name: event.target.value })} value={draft.display_name} /></label>
            <label>{copy.summary} <input onChange={(event) => setDraft({ ...draft, summary: event.target.value })} value={draft.summary} /></label>
            <label>{copy.category} <input onChange={(event) => setDraft({ ...draft, category: event.target.value })} value={draft.category} /></label>
            <label>{copy.visibility}
              <select onChange={(event) => setDraft({ ...draft, visibility: event.target.value })} value={draft.visibility}>
                <option value="public">public</option>
                <option value="private">private</option>
              </select>
            </label>
            <button className="button" onClick={() => { void create(); }} type="button">{copy.create}</button>
          </section>

          <section className="account-card">
            <h2>{copy.assets}</h2>
            {assets.length === 0 ? <p className="muted">—</p> : (
              <ul className="account-list">
                {assets.map((asset) => {
                  const current = uploadDraft(asset.id);
                  return (
                    <li key={asset.id}>
                      <div><b>{asset.display_name}</b> <span className="muted">{asset.kind} · {asset.public_latest_version ?? "—"}</span></div>
                      <div className="account-upload">
                        <input onChange={(event) => setUploads({ ...uploads, [asset.id]: { ...current, version: event.target.value } })} placeholder={copy.version} value={current.version} />
                        <input onChange={(event) => setUploads({ ...uploads, [asset.id]: { ...current, changelog: event.target.value } })} placeholder={copy.changelog} value={current.changelog} />
                        <input accept=".zip,.sdresearch" onChange={(event) => setUploads({ ...uploads, [asset.id]: { ...current, file: event.target.files?.[0] ?? null } })} type="file" />
                        <button
                          className="button button-ghost"
                          disabled={!current.file || !current.version}
                          onClick={() => {
                            if (!current.file) return;
                            void uploadVersion(asset.id, current.version, current.changelog, current.file)
                              .then(async () => { setNotice(`${asset.display_name}: ${copy.pending}`); await refresh(user); })
                              .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
                          }}
                          type="button"
                        >{copy.upload}</button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {user.role === "admin" ? (
            <section className="account-card">
              <h2>{copy.review}</h2>
              {queue.length === 0 ? <p className="muted">—</p> : (
                <ul className="account-list">
                  {queue.map((item) => (
                    <li key={`${item.asset_id}@${item.version}`}>
                      <div><b>{item.asset_name}</b> <span className="muted">{item.version} · {item.publisher_name} · {item.filename}</span></div>
                      <div className="account-actions">
                        <button className="button" onClick={() => { void decide(item.asset_id, item.version, "approve").then(async () => refresh(user)).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught))); }} type="button">{copy.approve}</button>
                        <button className="button button-ghost" onClick={() => { void decide(item.asset_id, item.version, "reject", "manual review").then(async () => refresh(user)).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught))); }} type="button">{copy.reject}</button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

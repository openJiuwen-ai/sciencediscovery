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

const pad = (part: number) => String(part).padStart(2, "0");

/**
 * A message's send time in the viewer's local clock as `YYYY-MM-DD HH:MM:SS`.
 *
 * The format is fixed rather than locale-dependent: the point of showing it is
 * to compare when things were sent against a wall clock the researcher already
 * has, so the digits must read the same whatever UI language is active.
 * Unparseable or missing values return "" so the caller renders nothing instead
 * of an empty badge.
 */
export function formatMessageTime(value?: string): string {
  const raw = value?.trim();
  if (!raw) return "";
  const sent = new Date(raw);
  if (Number.isNaN(sent.getTime())) return "";
  return `${sent.getFullYear()}-${pad(sent.getMonth() + 1)}-${pad(sent.getDate())} `
    + `${pad(sent.getHours())}:${pad(sent.getMinutes())}:${pad(sent.getSeconds())}`;
}

/** When one chat message was sent, as small muted text beside the sender. */
export function MessageTime({ value }: { value?: string }) {
  if (!value) return null;
  const text = formatMessageTime(value);
  if (!text) return null;
  return <time className="message-time" dateTime={value}>{text}</time>;
}
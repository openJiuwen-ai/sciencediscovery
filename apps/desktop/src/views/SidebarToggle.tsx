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

import { TEXT } from "../text.js";

/**
 * The panel outline that folds the sidebar away. One component for the two
 * places it appears: in the sidebar's own head while the sidebar is open, and
 * at the left of the page head once it is not.
 */
export function SidebarToggle({ onClick, open }: { onClick: () => void; open: boolean }) {
  return (
    <button
      aria-expanded={open}
      aria-label={open ? TEXT.sidebar.collapseSidebar : TEXT.sidebar.expandSidebar}
      className="icon-btn side-toggle"
      onClick={onClick}
      title={open ? TEXT.sidebar.collapseSidebar : TEXT.sidebar.expandSidebar}
      type="button"
    >
      <svg aria-hidden="true" fill="none" height="18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24" width="18">
        <rect height="15" rx="2.5" width="17" x="3.5" y="4.5" />
        <path d="M9.5 4.5v15" />
      </svg>
    </button>
  );
}

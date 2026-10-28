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

import { useRef, useState } from "react";

import type { Project } from "../api/types.js";
import { projectWithName } from "../app/project-name.js";
import { TEXT } from "../text.js";
import { PromptDialog } from "./PromptDialog.js";
import { RowMenu, type MenuItem, type MenuState } from "./RowMenu.js";

interface Props {
  /** The Project the next conversation would go into; `undefined` until the
   *  boot has settled, and never the inbox — which is not one of `projects`. */
  activeProjectId?: string;
  /** The name of that Project as the strip shows it. Passed rather than
   *  derived, because the inbox is a Project the list does not contain. */
  label: string;
  onCreateProject: (name: string) => void;
  /** `undefined` means no Project at all: the inbox, whose Sessions the column
   *  lists under 最近会话. */
  onSelectProject: (projectId?: string) => void;
  projects: Project[];
}

/**
 * What the picker offers, in the order the reference menu puts it in: the
 * Projects, a hairline, then the way to make another and the way to work
 * outside all of them.
 *
 * Split out from the component because the menu only exists while it is open,
 * and the tests in this app render on the server — where nothing is ever
 * clicked. This is the part worth asserting.
 */
export function projectChoices(
  projects: Project[],
  activeProjectId: string | undefined,
  handlers: { onCreate: () => void; onSelect: (projectId?: string) => void },
): MenuItem[] {
  return [
    ...projects.map((project) => ({
      checked: project.id === activeProjectId,
      icon: <span className="ctx-folder" />,
      label: project.name,
      onSelect: () => handlers.onSelect(project.id),
    })),
    {
      // The hairline is between the list and what acts on it: the Projects are
      // things to join, the two below are ways out of the list.
      icon: <span aria-hidden="true">＋</span>,
      label: TEXT.sidebar.newProject,
      onSelect: handlers.onCreate,
      separatorBefore: true,
    },
    {
      // The inbox has no row of its own to mark, so this entry is it: checked
      // whenever the Project in effect is not one the list contains.
      checked: !projects.some((project) => project.id === activeProjectId),
      icon: <span aria-hidden="true">✕</span>,
      label: TEXT.landing.noProject,
      onSelect: () => handlers.onSelect(undefined),
    },
  ];
}

/**
 * The project chip under the welcome page's composer.
 *
 * It reads like a label and behaves like a choice: the next conversation can
 * go into any Project the user made, into a new one, or into none at all. The
 * last is not an absence of an answer — those Sessions land in 最近会话, the
 * section the column keeps for conversations that belong to no Project.
 *
 * Nothing is written until the first message, so trying a Project and coming
 * back to no Project costs nothing.
 */
export function ProjectPicker({
  activeProjectId,
  label,
  onCreateProject,
  onSelectProject,
  projects,
}: Props) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuState>();
  const [creating, setCreating] = useState(false);

  // No Project chosen: the chip stops being a name and becomes the invitation
  // to pick one. The inbox is a Project, but it is not one the user chose —
  // 最近会话 names where the Session ends up, not where it is going.
  const standalone = !projects.some((project) => project.id === activeProjectId);

  const open = () => {
    const box = trigger.current?.getBoundingClientRect();
    setMenu({
      anchor: trigger.current,
      items: projectChoices(projects, activeProjectId, {
        onCreate: () => setCreating(true),
        onSelect: onSelectProject,
      }),
      note: TEXT.landing.noProjectNote,
      // Anchored to the chip's own box, not the pointer: the menu is a choice
      // about what is written there, and opening it twice should not drift.
      x: box?.left ?? 0,
      y: (box?.bottom ?? 0) + 6,
    });
  };

  return (
    <>
      <button
        aria-expanded={menu !== undefined}
        aria-haspopup="menu"
        aria-label={TEXT.landing.chooseProject}
        className={`composer-strip-project${standalone ? " is-placeholder" : ""}`}
        onClick={() => (menu === undefined ? open() : setMenu(undefined))}
        ref={trigger}
        title={TEXT.landing.chooseProject}
        type="button"
      >
        <span aria-hidden="true" className="composer-strip-icon" data-kind="folder" />
        <span className="composer-strip-label">{label}</span>
        <svg
          aria-hidden="true"
          className="composer-strip-chev"
          fill="none"
          height="12"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width="12"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      <RowMenu menu={menu} onClose={() => setMenu(undefined)} />

      {creating ? (
        <PromptDialog
          accept={TEXT.menu.confirm}
          eyebrow={TEXT.sidebar.project}
          fieldLabel={TEXT.sidebar.projectName}
          onCancel={() => setCreating(false)}
          onSubmit={(name) => {
            setCreating(false);
            onCreateProject(name);
          }}
          placeholder={TEXT.sidebar.projectName}
          title={TEXT.sidebar.newProject}
          validate={(name) =>
            projectWithName(projects, name) === undefined
              ? undefined
              : TEXT.sidebar.projectNameTaken(name)}
        />
      ) : null}
    </>
  );
}

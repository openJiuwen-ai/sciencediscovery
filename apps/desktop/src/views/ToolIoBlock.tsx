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

import { TEXT } from "../text.js";

/**
 * One labeled piece of a tool call — its input, its result, or one labeled
 * slice of it — drawn as a small gray code tile under a quiet label.
 *
 * Inline the tile is a preview: it is clipped to a few lines, and pressing it
 * hands the whole text to the right panel, where the width and the height are.
 * The panel itself draws the same tile without `onOpen`, which is what makes
 * the two views one component rather than two copies that can drift.
 */
export function ToolIoBlock({
  content,
  label,
  onOpen,
}: {
  content: string;
  label: string;
  /** Absent where there is nowhere bigger to read the text. The tile is then
   *  a plain block rather than a door. */
  onOpen?: () => void;
}) {
  const code = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  // Whether the tile is cut short cannot be asked of the CSS alone: the same
  // class is a short input and a long result. Measuring the box is what lets
  // the fade appear only where there is more text underneath it.
  useEffect(() => {
    const node = code.current;
    if (node === null) return;
    const measure = () => setClipped(node.scrollHeight > node.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [content]);

  const text = <pre className="tool-io-code-text">{content}</pre>;
  return (
    <div className="tool-io-block">
      <div className="tool-io-block-head">
        <span className="tool-io-label">{label}</span>
        {onOpen === undefined ? null : <span className="tool-io-hint">{TEXT.conversation.openInPanel}</span>}
      </div>
      {onOpen === undefined ? (
        <div className="tool-io-code" ref={code}>{text}</div>
      ) : (
        <div
          className={`tool-io-code is-openable${clipped ? " is-clipped" : ""}`}
          onClick={onOpen}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onOpen();
          }}
          ref={code}
          role="button"
          tabIndex={0}
        >
          {text}
        </div>
      )}
    </div>
  );
}

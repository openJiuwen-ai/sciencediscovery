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
 * Where a session-settings flyout hangs beside its panel.
 *
 * The flyout is a card beside the column of rows, not a child of it: it has a
 * fixed width (300px for 审查档位, 380px for 专家) and the column sits wherever
 * the composer's 会话设置 button is. Near the right edge of a narrow window the
 * card would run past the window and be clipped by the column that holds the
 * menu, losing its right border and the end of every row's text (#1487).
 *
 * The placement is the same shape as `RowMenu`'s: keep the card on the panel's
 * right when it fits, otherwise put it entirely on the panel's left, and clamp
 * the result into the window only when neither side can hold it. Clamping
 * alone is deliberately not the first answer — it would draw the card over the
 * rows the reader just opened.
 */
export interface FlyoutAnchor {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

export interface FlyoutSize {
  height: number;
  width: number;
}

export interface ViewportSize {
  height: number;
  width: number;
}

/** The hairline between the panel and its card. */
const GAP = 4;
/** The window edge the card never crosses. */
const MARGIN = 8;

export interface FlyoutPlacement {
  left: number;
  top: number;
}

/**
 * `align` is the edge the card is anchored by: 审查档位 hangs from the panel's
 * top edge, 专家 from its bottom, because the expert catalog is as tall as its
 * content and the composer already sits at the bottom of the window.
 */
export function placeFlyout(
  anchor: FlyoutAnchor,
  size: FlyoutSize,
  viewport: ViewportSize,
  align: "bottom" | "top",
): FlyoutPlacement {
  const rightOfPanel = anchor.right + GAP;
  const leftOfPanel = anchor.left - GAP - size.width;
  const farthestLeft = Math.max(MARGIN, viewport.width - MARGIN - size.width);
  const left = rightOfPanel + size.width <= viewport.width - MARGIN
    ? rightOfPanel
    : Math.min(Math.max(leftOfPanel, MARGIN), farthestLeft);
  const anchoredTop = align === "bottom" ? anchor.bottom - size.height : anchor.top;
  const farthestTop = Math.max(MARGIN, viewport.height - MARGIN - size.height);
  return {
    left,
    top: Math.min(Math.max(anchoredTop, MARGIN), farthestTop),
  };
}

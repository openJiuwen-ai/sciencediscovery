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
 * Inline icons for the hub. Every glyph is a stroke drawing on `currentColor`,
 * so a card tile, a sidebar row and a detail heading can share one shape and
 * only carry the colour of their surface.
 */

import type { JSX, ReactNode } from "react";
import type { Asset } from "../catalog/types.js";

export interface IconProps {
  className?: string;
  size?: number;
}

function Svg({ children, className, size = 20 }: IconProps & { children: ReactNode }): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      {children}
    </svg>
  );
}

export const SearchIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M15.6 15.6 20 20" />
  </Svg>
);

export const DownloadIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M12 4v10" />
    <path d="m8 10 4 4 4-4" />
    <path d="M5 19h14" />
  </Svg>
);

export const BackIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M15 5l-7 7 7 7" />
  </Svg>
);

export const GlobeIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17" />
    <path d="M12 3.5c2.6 2.4 3.9 5.3 3.9 8.5S14.6 18.1 12 20.5C9.4 18.1 8.1 15.2 8.1 12S9.4 5.9 12 3.5Z" />
  </Svg>
);

// --- asset kinds -----------------------------------------------------------

export const SkillIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M12 3.5 19 7.5v9L12 20.5 5 16.5v-9Z" />
    <path d="m5 7.5 7 4 7-4" />
    <path d="M12 11.5v9" />
  </Svg>
);

export const TeamIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <circle cx="9" cy="9" r="3.2" />
    <path d="M3.8 19c.4-3 2.6-4.8 5.2-4.8s4.8 1.8 5.2 4.8" />
    <path d="M15.5 6.3a3 3 0 0 1 0 5.4" />
    <path d="M16.8 14.5c2 .5 3.3 2.2 3.6 4.5" />
  </Svg>
);

export const SpecialistIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <rect height="15" rx="3" width="16" x="4" y="4.5" />
    <circle cx="12" cy="10" r="2.4" />
    <path d="M8.2 16c.6-2 2-3.1 3.8-3.1s3.2 1.1 3.8 3.1" />
  </Svg>
);

export const ConnectorIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M10 14a4.2 4.2 0 0 0 6 0l2.5-2.5a4.2 4.2 0 0 0-6-6L11 7" />
    <path d="M14 10a4.2 4.2 0 0 0-6 0l-2.5 2.5a4.2 4.2 0 0 0 6 6L13 17" />
  </Svg>
);

export const SessionIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <rect height="13" rx="2.4" width="14" x="5" y="7" />
    <path d="M8.5 4.2h7" />
    <path d="M8.5 11h7" />
    <path d="M8.5 14.5h4" />
  </Svg>
);

const KIND_ICONS: Record<Asset["kind"], (props: IconProps) => JSX.Element> = {
  connector: ConnectorIcon,
  "session-package": SessionIcon,
  skill: SkillIcon,
  specialist: SpecialistIcon,
  "team-skill": TeamIcon,
};

export function KindIcon({ kind, ...props }: IconProps & { kind: Asset["kind"] }): JSX.Element {
  const Icon = KIND_ICONS[kind];
  return <Icon {...props} />;
}

// --- category glyphs -------------------------------------------------------

const GridIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <rect height="6" rx="1.4" width="6" x="4" y="4" />
    <rect height="6" rx="1.4" width="6" x="14" y="4" />
    <rect height="6" rx="1.4" width="6" x="4" y="14" />
    <rect height="6" rx="1.4" width="6" x="14" y="14" />
  </Svg>
);

const DnaIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M8 3.5c0 5 8 6 8 11M16 3.5c0 5-8 6-8 11" />
    <path d="M8 20.5c0-2 1.3-3.4 3-4.4M16 20.5c0-2-1.3-3.4-3-4.4" />
    <path d="M8.6 8.2h6.8M9.7 12.5h4.6" />
  </Svg>
);

const CrossIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <rect height="16" rx="3" width="16" x="4" y="4" />
    <path d="M12 8v8M8 12h8" />
  </Svg>
);

const WrenchIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M14.5 4.5a4.5 4.5 0 0 0 5 6.2l-8.8 8.8a2.6 2.6 0 0 1-3.7-3.7l8.8-8.8a4.5 4.5 0 0 1-1.3-2.5Z" />
    <path d="m5.6 18.4 1.9-1.9" />
  </Svg>
);

const FlaskIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M9.5 3.5h5" />
    <path d="M10 3.5v5.2L5.6 16a2.6 2.6 0 0 0 2.2 4h8.4a2.6 2.6 0 0 0 2.2-4L14 8.7V3.5" />
    <path d="M7.4 14.5h9.2" />
  </Svg>
);

const WavesIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M3.5 8.5c2-2 4-2 6 0s4 2 6 0 3.4-1.6 5-1" />
    <path d="M3.5 13c2-2 4-2 6 0s4 2 6 0 3.4-1.6 5-1" />
    <path d="M3.5 17.5c2-2 4-2 6 0s4 2 6 0 3.4-1.6 5-1" />
  </Svg>
);

const ChipIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <rect height="10" rx="2" width="10" x="7" y="7" />
    <path d="M10 3.5v2M14 3.5v2M10 18.5v2M14 18.5v2M3.5 10h2M3.5 14h2M18.5 10h2M18.5 14h2" />
  </Svg>
);

const BoltIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M13.5 3.5 6.5 13h4.4l-1.4 7.5 7.9-10h-4.6Z" />
  </Svg>
);

const ChartIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M4 19.5h16" />
    <path d="M7 19.5v-5M12 19.5V8M17 19.5v-8" />
  </Svg>
);

const SigmaIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M17 5.5H7.5l5 6.5-5 6.5H17" />
  </Svg>
);

const AtomIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="2" />
    <ellipse cx="12" cy="12" rx="8.5" ry="3.6" />
    <ellipse cx="12" cy="12" rx="3.6" ry="8.5" />
  </Svg>
);

const BatteryIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <rect height="9" rx="2" width="15" x="3.5" y="7.5" />
    <path d="M20.5 10.5v3" />
    <path d="M6.5 10.5v3M10 10.5v3M13.5 10.5v3" />
  </Svg>
);

const StarIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="m12 4 2.5 5.2 5.5.8-4 3.9.9 5.6-4.9-2.6-4.9 2.6.9-5.6-4-3.9 5.5-.8Z" />
  </Svg>
);

const BookIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="M4 5.5c2.6-1 5.2-1 8 0 2.8-1 5.4-1 8 0v13c-2.6-1-5.2-1-8 0-2.8-1-5.4-1-8 0Z" />
    <path d="M12 5.5v13" />
  </Svg>
);

const DatabaseIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <ellipse cx="12" cy="6.2" rx="7" ry="2.7" />
    <path d="M5 6.2v11.6c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7V6.2" />
    <path d="M5 12c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7" />
  </Svg>
);

const LayersIcon = (props: IconProps): JSX.Element => (
  <Svg {...props}>
    <path d="m12 4 8 4-8 4-8-4Z" />
    <path d="m4 12 8 4 8-4" />
    <path d="m4 16 8 4 8-4" />
  </Svg>
);

const CATEGORY_ICONS: Record<string, (props: IconProps) => JSX.Element> = {
  astronomy: StarIcon,
  biology: DnaIcon,
  "capability-evolution": LayersIcon,
  chemistry_and_materials: FlaskIcon,
  "compound-drug": FlaskIcon,
  "dataset-knowledge": DatabaseIcon,
  earth_sciences: GlobeIcon,
  economics: ChartIcon,
  electromagnetics: BoltIcon,
  energy: BatteryIcon,
  fluid_dynamics: WavesIcon,
  "genome-variant-pathway": DnaIcon,
  literature: BookIcon,
  machine_learning: ChipIcon,
  mathematics: SigmaIcon,
  medical_and_pharmacy: CrossIcon,
  quantum: AtomIcon,
  research_tools: WrenchIcon,
  "sequence-structure": LayersIcon,
};

export function CategoryIcon({ id, ...props }: IconProps & { id: string }): JSX.Element {
  const Icon = CATEGORY_ICONS[id] ?? GridIcon;
  return <Icon {...props} />;
}

export { GridIcon };

// --- brand -----------------------------------------------------------------

/** The site mark: a hexagonal cell holding a spark, drawn on the brand gradient. */
export function BrandMark({ size = 30 }: { size?: number }): JSX.Element {
  return (
    <svg aria-hidden="true" height={size} viewBox="0 0 32 32" width={size}>
      <defs>
        <linearGradient id="hub-brand" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#1e54fa" />
          <stop offset="1" stopColor="#842efd" />
        </linearGradient>
      </defs>
      <rect fill="url(#hub-brand)" height="32" rx="9" width="32" />
      <path d="M16 7.4 23.2 11.6v8.2L16 24l-7.2-4.2v-8.2Z" fill="none" stroke="#fff" strokeWidth="1.8" />
      <path d="m16 12.2 1.6 2.2 2.7.4-2 1.9.5 2.7-2.8-1.4-2.8 1.4.5-2.7-2-1.9 2.7-.4Z" fill="#fff" />
    </svg>
  );
}

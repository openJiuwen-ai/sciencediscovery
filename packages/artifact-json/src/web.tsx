// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { ReactNode } from "react";
import type { ViewContribution } from "@sciencediscovery/plugin-sdk/views";

export interface JsonPreviewInput {
  kind: "json";
  parsed: boolean;
  source: string;
  truncated: boolean;
  labels: { invalidJson: string; truncated: string };
  renderSource?: (source: string) => ReactNode;
}
export function JsonPreview({ parsed, source, truncated, labels, renderSource }: JsonPreviewInput) {
  return <div className="json-source-preview">
    {parsed ? null : <p className="artifact-empty compact">{labels.invalidJson}</p>}
    {truncated ? <p className="dataset-table-meta">{labels.truncated}</p> : null}
    {renderSource ? renderSource(source) : <pre className="artifact-source-preview">{source}</pre>}
  </div>;
}
export const jsonViewer: ViewContribution<JsonPreviewInput, ReactNode> = {
  id: "artifact.json", pluginId: "artifact-json", priority: 10,
  matches: (input) => input.kind === "json",
  render: (input) => <JsonPreview {...input} />,
};

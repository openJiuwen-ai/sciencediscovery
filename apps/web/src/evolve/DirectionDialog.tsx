// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License").

import { useEffect, useId, useRef, useState } from "react";
import type { EvolveAlgorithm, EvolveDirectionInput } from "@sciencediscovery/schema";

import { DirectionInput } from "./DirectionInput.js";
import { EvolveAlgorithmPicker } from "./EvolveAlgorithmPicker.js";

export function DirectionDialog({ chinese, task, initialAlgorithm, onClose, onConfirm, onGenerate, value }: {
  chinese: boolean;
  task: string;
  onClose: () => void;
  initialAlgorithm: EvolveAlgorithm;
  onConfirm: (algorithm: EvolveAlgorithm, value?: EvolveDirectionInput) => void;
  onGenerate?: (signal: AbortSignal) => Promise<EvolveDirectionInput>;
  value?: EvolveDirectionInput;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [draft, setDraft] = useState(value);
  const [algorithm, setAlgorithm] = useState(initialAlgorithm);
  const [customScope, setCustomScope] = useState(Boolean(value?.editable.length));
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  return <dialog aria-labelledby={title} className="evolve-direction-dialog" ref={dialog}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="evolve-direction-card">
      <header className="evolve-direction-heading">
        <div>
          <span>{chinese ? "程序演进" : "Program evolution"}</span>
          <h2 id={title}>{chinese ? "确认演进设置" : "Confirm evolution settings"}</h2>
          {task ? <p>{task}</p> : null}
        </div>
        <button type="button" className="icon-button" aria-label={chinese ? "关闭" : "Close"} onClick={onClose}>×</button>
      </header>
      <div className="evolve-direction-body">
        <EvolveAlgorithmPicker selected={algorithm} onSelect={setAlgorithm} />
        <label className="evolve-submit-scope">
          <input type="checkbox" role="switch" checked={customScope} onChange={(event) => setCustomScope(event.target.checked)} />
          <span>{chinese ? "自定义 JSON 与修改范围" : "Custom JSON and edit scope"}</span>
        </label>
        <div hidden={!customScope}>
          <DirectionInput chinese={chinese} onChange={setDraft} onGenerate={onGenerate} value={value} />
        </div>
      </div>
      <footer className="evolve-direction-actions">
        <button className="secondary-button" type="button" onClick={onClose}>{chinese ? "取消" : "Cancel"}</button>
        <button className="primary-button" type="button" disabled={customScope && !draft?.editable.length}
          onClick={() => {
            if (!customScope || draft?.editable.length) onConfirm(algorithm, customScope ? draft : undefined);
          }}>{chinese ? "开始演进" : "Start evolution"}</button>
      </footer>
    </div>
  </dialog>;
}

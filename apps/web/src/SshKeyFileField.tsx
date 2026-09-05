// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { useEffect, useId, useRef, useState } from "react";
import type { SshKeyFileListing } from "@sciencediscovery/schema";
import type { ApiClient } from "./api.js";

/** Browse the API machine, not the browser's upload filesystem. */
export function SshKeyFileField({ client, label, value, placeholder, disabled, onChange }: {
  client: ApiClient;
  label: string;
  value: string;
  placeholder: string;
  disabled?: boolean;
  onChange: (path: string) => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const generation = useRef(0);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [location, setLocation] = useState("");
  const [listing, setListing] = useState<SshKeyFileListing>();
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => {
    if (open) dialog.current?.showModal();
  }, [open]);

  function close(): void {
    dialog.current?.close();
    generation.current++;
    setOpen(false);
    setLoading(false);
    setListing(undefined);
    setError("");
  }

  async function browse(path?: string, page = 0): Promise<void> {
    const request = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const result = await client.listSshKeyFiles(path, page);
      if (request !== generation.current) return;
      setListing(result);
      setLocation(result.directory);
      setOffset(page);
    } catch (reason) {
      if (request !== generation.current) return;
      setListing(undefined);
      setError(reason instanceof Error ? reason.message : "Could not browse the application machine");
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }

  return <div className="ssh-key-file-field">
    <label htmlFor={id}>{label}</label>
    <div className="ssh-key-file-path">
      <input id={id} autoComplete="off" value={value} disabled={disabled}
        onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      <button className="secondary-button" type="button" disabled={disabled} aria-expanded={open} aria-haspopup="dialog"
        onClick={() => {
          if (open) close();
          else { setOpen(true); setLocation(value); void browse(value || undefined); }
        }}>Browse</button>
    </div>
    {open ? <dialog ref={dialog} className="ssh-key-file-dialog" aria-labelledby={id + "-title"}
      onCancel={(event) => { event.preventDefault(); event.stopPropagation(); close(); }}
      onKeyDown={(event) => event.stopPropagation()}>
      <section className="ssh-key-file-browser" aria-label="Files on application machine" aria-busy={loading}>
      <strong id={id + "-title"}>Select a key on the application machine</strong>
      <p>Files belong to the machine running ScienceDiscovery, not this browser or the remote SSH target. Only the selected path is filled in; file contents are never displayed.</p>
      <label htmlFor={id + "-location"}>Directory or file path</label>
      <div className="ssh-key-file-path">
        <input id={id + "-location"} value={location} disabled={disabled || loading} placeholder="~/.ssh"
          onChange={(event) => setLocation(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); void browse(location || undefined); }
          }} />
        <button className="secondary-button" type="button" disabled={disabled || loading}
          onClick={() => void browse(location || undefined)}>Go</button>
      </div>
      <div className="ssh-key-file-navigation">
        <button className="secondary-button" type="button" disabled={disabled || loading || !listing?.parentDirectory}
          onClick={() => void browse(listing!.parentDirectory!)}>Up</button>
        <button className="secondary-button" type="button" disabled={disabled || loading} onClick={() => void browse("~")}>Home</button>
        <button className="secondary-button" type="button" onClick={close}>Cancel selection</button>
      </div>
      {error ? <div role="alert">{error}</div> : null}
      {loading ? <p role="status">Loading files…</p> : listing ? <>
        <p className="ssh-key-file-directory">{listing.directory}</p>
        {listing.entries.length ? <ul>{listing.entries.map((entry) => <li key={entry.path}>
          <button className="secondary-button" type="button" disabled={disabled || entry.kind === "unavailable"}
            onClick={() => {
              if (entry.kind === "directory") void browse(entry.path);
              else { onChange(entry.path); close(); }
            }}>
            <span>{entry.name}</span><small>{entry.kind === "directory" ? "Folder" : entry.kind === "file" ? "Select file" : "Unavailable"}</small>
          </button>
        </li>)}</ul> : <p>No files in this directory.</p>}
        {offset > 0 || listing.nextOffset !== null ? <div className="ssh-key-file-navigation">
          <button className="secondary-button" type="button" disabled={disabled || offset === 0}
            onClick={() => void browse(listing.directory, Math.max(0, offset - 100))}>Previous page</button>
          <button className="secondary-button" type="button" disabled={disabled || listing.nextOffset === null}
            onClick={() => void browse(listing.directory, listing.nextOffset!)}>Next page</button>
        </div> : null}
      </> : null}
    </section></dialog> : null}
  </div>;
}

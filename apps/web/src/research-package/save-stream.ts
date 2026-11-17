/**
 * Write a research-package export straight to disk.
 *
 * The archive can be several GiB, so the response body is piped to a file
 * stream instead of being materialised with `response.blob()`. The picker is
 * opened *before* the request: `showSaveFilePicker` needs the click's transient
 * user activation, which a `fetch` round trip would already have consumed.
 * Aborting the writable discards the temporary file, so a refused export
 * leaves nothing behind on disk.
 */
const ARCHIVE_TYPES = [{ description: "ScienceDiscovery research package", accept: { "application/octet-stream": [".sdresearch"] } }];

type WritableLike = {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
};
type FileHandleLike = { createWritable(): Promise<WritableLike> };
type SaveFilePicker = (options: { suggestedName: string; types: typeof ARCHIVE_TYPES }) => Promise<FileHandleLike>;

export type SaveOutcome = "saved" | "cancelled";
export type SaveHooks = {
  picker?: SaveFilePicker;
  download?: (blob: Blob, name: string) => void;
};

function defaultDownload(blob: Blob, name: string): void {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function isAbort(reason: unknown): boolean {
  return typeof reason === "object" && reason !== null && (reason as { name?: unknown }).name === "AbortError";
}

/**
 * `open` performs the request; it is called after the picker so the file dialog
 * still belongs to the click. Without the File System Access API the response is
 * buffered into the pre-existing anchor download, which is the old behaviour.
 */
export async function savePackageResponse(open: () => Promise<Response>, name: string, hooks: SaveHooks = {}): Promise<SaveOutcome> {
  const picker = hooks.picker ?? (globalThis as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  if (!picker) {
    const response = await open();
    (hooks.download ?? defaultDownload)(await response.blob(), name);
    return "saved";
  }
  let handle: FileHandleLike;
  try {
    handle = await picker({ suggestedName: name, types: ARCHIVE_TYPES });
  } catch (reason) {
    if (isAbort(reason)) return "cancelled";
    throw reason;
  }
  const writable = await handle.createWritable();
  try {
    const response = await open();
    if (!response.body) {
      await writable.write(new Uint8Array(await response.arrayBuffer()));
      await writable.close();
    } else {
      await response.body.pipeTo(writable as unknown as WritableStream<Uint8Array>);
    }
    return "saved";
  } catch (reason) {
    await writable.abort?.(reason).catch(() => undefined);
    throw reason;
  }
}

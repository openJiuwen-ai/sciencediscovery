/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API prefix used to resolve downloads, e.g. `/api/v1`. Empty means static. */
  readonly VITE_HUB_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Chrome's File System Access API: a save dialog the page can write to. It is
// optional in the type system because Firefox and Safari do not implement it.
interface SaveFilePickerOptions {
  suggestedName?: string;
}

interface SaveFileHandle {
  createWritable(): Promise<WritableStream<Uint8Array>>;
}

interface Window {
  showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<SaveFileHandle>;
}

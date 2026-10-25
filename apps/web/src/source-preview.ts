// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

export const SOURCE_PREVIEW_LIMIT = 100_000;

const languages: Record<string, string> = {
  py: "python", r: "r", jl: "julia", js: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", jsx: "javascript", tsx: "typescript", sh: "bash", bash: "bash", sql: "sql",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", java: "java",
  go: "go", rs: "rust", json: "json", ipynb: "json", yaml: "yaml", yml: "yaml",
  toml: "ini", ini: "ini", xml: "xml", css: "css", html: "xml", htm: "xml",
  md: "markdown", markdown: "markdown", tex: "latex",
};

export function sourceLanguage(name = "", mediaType = ""): string {
  const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
  if (languages[extension]) return languages[extension];
  const type = (mediaType.split(";")[0] ?? "").trim().toLowerCase();
  return ({ "application/json": "json", "text/x-python": "python", "text/markdown": "markdown",
    "application/yaml": "yaml", "text/yaml": "yaml", "application/xml": "xml",
    "text/xml": "xml", "text/html": "xml", "text/css": "css", "application/javascript": "javascript",
    "text/javascript": "javascript", "application/x-tex": "latex" } as Record<string, string>)[type] ?? "plaintext";
}

/** Check metadata before decoding; unknown names still get a strict UTF-8 sniff. */
export async function readPreviewText(blob: Blob, name: string, mediaType = blob.type): Promise<string | undefined> {
  const type = (mediaType.split(";")[0] ?? "").trim().toLowerCase();
  if (/^(?:image|audio|video|font)\//.test(type)
    || /(?:pdf|zip|gzip|compressed|officedocument|msword|ms-excel|ms-powerpoint|hdf|parquet)/.test(type)
    || /\.(?:pdf|png|jpe?g|gif|webp|svg|ico|bmp|tiff?|avif|zip|gz|bz2|xz|7z|tar|docx?|xlsx?|pptx?|odt|ods|odp|h5|hdf5|npy|npz|parquet|arrow|feather|sqlite|db|exe|dll|so|wasm|woff2?|ttf|mp[34]|wav|ogg|mov|avi)$/i.test(name)) return undefined;
  // A streaming decoder accepts a multibyte character crossing the byte cap.
  const bytes = new Uint8Array(await blob.slice(0, SOURCE_PREVIEW_LIMIT * 4 + 4).arrayBuffer());
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: bytes.length < blob.size });
    // NUL and non-whitespace control characters are binary even in valid UTF-8.
    return /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text) ? undefined : text;
  } catch {
    return undefined;
  }
}

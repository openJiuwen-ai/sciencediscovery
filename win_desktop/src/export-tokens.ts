// Destination tokens for study-package export.
//
// The renderer runs with sandbox/contextIsolation and must not be able to name
// an arbitrary filesystem path: a write that accepts any path would let code
// executing in the renderer overwrite shell profiles, SSH keys and autostart
// entries. So the native save dialog hands out an opaque token and the main
// process keeps the path. The renderer passes only the token back, and nothing
// it sends can address a file the user did not pick.
//
// Pure functions/class, no Electron import: unit-tested without a host.

export interface IssuedDestination {
  /** The path the user picked in the native dialog. */
  path: string;
  /** True once the archive has been written through this token. */
  written: boolean;
}

export class ExportDestinations {
  private readonly issued = new Map<string, IssuedDestination>();
  private readonly limit: number;

  /** @param limit how many recent destinations stay resolvable; the oldest is
   *  dropped first so a long session cannot grow the map without bound. */
  constructor(limit = 32) {
    this.limit = limit;
  }

  /** Remember a path and return its token. */
  issue(token: string, path: string): string {
    this.issued.set(token, { path, written: false });
    while (this.issued.size > this.limit) {
      const oldest = this.issued.keys().next().value;
      if (oldest === undefined) break;
      this.issued.delete(oldest);
    }
    return token;
  }

  /** Resolve a token to its path; undefined for a token this process never
   *  issued (or one already evicted). */
  resolve(token: string): IssuedDestination | undefined {
    return this.issued.get(token);
  }

  /** Mark the destination as written so a repeated save can be recognised. */
  markWritten(token: string): void {
    const entry = this.issued.get(token);
    if (entry) entry.written = true;
  }

  get size(): number {
    return this.issued.size;
  }
}
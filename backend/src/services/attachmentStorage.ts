import { randomUUID } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Stores attachment bytes on disk under server-generated names. Callers never choose a path:
 * stored paths are `<2 hex>/<uuid>` with no extension, so nothing here can be executed or traversed,
 * and every path coming back from the database is re-validated against the storage root.
 */
export class AttachmentStorage {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  async save(content: Buffer): Promise<string> {
    const id = randomUUID();
    const relative = `${id.slice(0, 2)}/${id}`;
    const target = this.resolve(relative);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
    await writeFile(target, content, { mode: 0o640, flag: 'wx' });
    return relative;
  }

  open(relativePath: string): ReadStream {
    return createReadStream(this.resolve(relativePath));
  }

  async remove(relativePath: string): Promise<void> {
    await rm(this.resolve(relativePath), { force: true });
  }

  async removeMany(relativePaths: Array<string | null | undefined>): Promise<number> {
    let removed = 0;
    for (const p of relativePaths) {
      if (!p) continue;
      try {
        await this.remove(p);
        removed += 1;
      } catch {
        // A file we cannot delete must not block cleanup of the rest; the DB row is authoritative.
      }
    }
    return removed;
  }

  /** Resolves a stored relative path, refusing anything that escapes the storage root. */
  resolve(relativePath: string): string {
    if (path.isAbsolute(relativePath) || relativePath.includes('\0')) {
      throw new Error('Invalid attachment path');
    }
    const full = path.resolve(this.root, relativePath);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new Error('Invalid attachment path');
    }
    return full;
  }
}

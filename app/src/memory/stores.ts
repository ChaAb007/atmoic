import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import type { MemoryStore } from '@atomic-v2';

const FOLDER = 'atomic';
const FILE = `${FOLDER}/memory-v2.json`;
const TEMP = `${FOLDER}/memory-v2.json.tmp`;

/**
 * The memory file in the app's private storage on the phone. Saves write a temp file and swap it in, so a crash
 * mid-save never leaves a half-written memory; a leftover temp file is picked up on the next load.
 */
export class DeviceFileStore implements MemoryStore {
  async load(): Promise<string | undefined> {
    return (await this.read(FILE)) ?? (await this.read(TEMP));
  }

  async save(text: string): Promise<void> {
    await Filesystem.writeFile({ path: TEMP, data: text, directory: Directory.Data, encoding: Encoding.UTF8, recursive: true });
    await Filesystem.deleteFile({ path: FILE, directory: Directory.Data }).catch(() => undefined);
    await Filesystem.rename({ from: TEMP, to: FILE, directory: Directory.Data, toDirectory: Directory.Data });
  }

  private async read(path: string): Promise<string | undefined> {
    try {
      const result = await Filesystem.readFile({ path, directory: Directory.Data, encoding: Encoding.UTF8 });
      return typeof result.data === 'string' ? result.data : await result.data.text();
    } catch {
      return undefined;
    }
  }
}

/**
 * Browser storage for trying the app on a computer: the origin-private file system, then localStorage. When the
 * browser blocks both (a private window, a locked-down frame), memory lives only until the page closes.
 */
export class BrowserStore implements MemoryStore {
  private kept: string | undefined;

  async load(): Promise<string | undefined> {
    // An empty file means the browser created it but could not write it (Safari without createWritable).
    const fromFile = await this.readFile();
    if (fromFile) return fromFile;
    try {
      return localStorage.getItem('atomic.memory-v2') ?? this.kept;
    } catch {
      return this.kept;
    }
  }

  private async readFile(): Promise<string | undefined> {
    try {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle('memory-v2.json');
      return await (await handle.getFile()).text();
    } catch {
      return undefined;
    }
  }

  async save(text: string): Promise<void> {
    this.kept = text;
    try {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle('memory-v2.json', { create: true });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return;
    } catch {
      // fall through to localStorage
    }
    try {
      localStorage.setItem('atomic.memory-v2', text);
    } catch {
      // kept in memory only
    }
  }
}

export function createMemoryStore(): MemoryStore {
  return Capacitor.isNativePlatform() ? new DeviceFileStore() : new BrowserStore();
}

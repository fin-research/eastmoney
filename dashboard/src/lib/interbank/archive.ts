import type { PreparedBatch } from './model';

export type ArchiveDirectory = FileSystemDirectoryHandle & {
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
};

/** File handles are structured-cloned by IndexedDB; no business files are stored here. */
async function directoryStore(mode: IDBTransactionMode, handle?: ArchiveDirectory): Promise<ArchiveDirectory | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('eastmoney-interbank', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('directory');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('directory', mode);
      const store = transaction.objectStore('directory');
      const request = handle ? store.put(handle, 'archive-root') : store.get('archive-root');
      transaction.oncomplete = () => resolve(handle ?? request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('归档目录保存失败'));
    });
  } finally { db.close(); }
}
export const loadArchiveDirectory = () => directoryStore('readonly');
export const saveArchiveDirectory = (handle: ArchiveDirectory) => directoryStore('readwrite', handle);

export async function saveArchive(root: FileSystemDirectoryHandle, batch: PreparedBatch, checkActive: () => void) {
  checkActive();
  const directory = await root.getDirectoryHandle(batch.date, { create: true });
  const pending: { file: PreparedBatch['files'][number]; parent: FileSystemDirectoryHandle; name: string }[] = [];
  // Check every target before writing, so differing local files are never overwritten.
  for (const file of batch.files) {
    checkActive();
    const parts = file.name.split('/');
    let parent = directory;
    for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part, { create: true });
    const name = parts.at(-1)!;
    let existing: FileSystemFileHandle | undefined;
    try { existing = await parent.getFileHandle(name); }
    catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
    if (existing) {
      const bytes = new Uint8Array(await (await existing.getFile()).arrayBuffer());
      if (bytes.length !== file.bytes.length || bytes.some((value, i) => value !== file.bytes[i])) throw new Error(`目录已有不同文件：${file.name}`);
    } else pending.push({ file, parent, name });
  }
  for (const { file, parent, name } of pending) {
    checkActive();
    const handle = await parent.getFileHandle(name, { create: true });
    const stream = await handle.createWritable();
    try { await stream.write(new Uint8Array(file.bytes).buffer); await stream.close(); }
    catch (error) { await stream.abort().catch(() => {}); throw error; }
  }
  checkActive();
}

// Two-way "Sync folder" engine.
//
// How it works:
// - The user picks a folder on their device (File System Access API,
//   Chrome/Edge desktop only). We link it to a Drive folder.
// - Every time the user taps "Sync Now", we walk both trees, compare
//   against a manifest of what we last synced, and:
//     - new local files/folders  -> uploaded to Drive
//     - new Drive files/folders  -> downloaded to the device
//     - a file changed only on one side -> pushed to the other side
//     - a file changed on BOTH sides, or a same-named file exists on both
//       sides with no prior link (a genuine conflict) -> we keep BOTH:
//       the device copy is uploaded as a renamed duplicate rather than
//       overwriting anything.
// - Deleting a file on one side does NOT delete it on the other side —
//   we never destroy data automatically. That's a deliberate limitation.
//
// This only runs while the tab is open (browsers can't run this with the
// site fully closed), and only in browsers that support
// window.showDirectoryPicker (Chrome/Edge desktop).

import { idbGet, idbSet, idbDelete } from './syncIdb.js';

const LINK_KEY = 'sync_link';
const MANIFEST_KEY = 'sync_manifest';

export function isFolderSyncSupported() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export async function getSyncLink() {
  return (await idbGet(LINK_KEY)) || null;
}

export async function unlinkSyncFolder() {
  await idbDelete(LINK_KEY);
  await idbDelete(MANIFEST_KEY);
}

export async function pickAndLinkFolder({ macroUrl, parentFolderId }) {
  if (!isFolderSyncSupported()) {
    throw new Error("Your browser doesn't support folder sync — use Chrome or Edge on desktop.");
  }
  const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  const folderName = dirHandle.name;
  const driveFolderId = await findOrCreateDriveFolder(macroUrl, folderName, parentFolderId);

  const link = {
    dirHandle,
    driveFolderId,
    folderName,
    parentFolderId,
    linkedAt: Date.now(),
    lastSyncedAt: null,
  };
  await idbSet(LINK_KEY, link);
  await idbSet(MANIFEST_KEY, {});
  return link;
}

export async function runSync({ macroUrl, onLog }) {
  const link = await getSyncLink();
  if (!link) throw new Error('No folder linked yet.');

  const granted = await verifyPermission(link.dirHandle, true);
  if (!granted) throw new Error('Permission to the device folder was denied.');

  const log = (msg) => { if (onLog) onLog(msg); };
  const manifest = (await idbGet(MANIFEST_KEY)) || {};
  const summary = {
    uploaded: 0, downloaded: 0, updatedOnDrive: 0, updatedLocal: 0,
    renamedConflicts: 0, foldersCreated: 0, skipped: 0, errors: 0,
  };

  log('Scanning device folder…');
  const localMap = await walkLocal(link.dirHandle);
  log('Scanning Drive folder…');
  const driveMap = await walkDrive(macroUrl, link.driveFolderId);

  // --- Directories: local -> Drive ---
  const localDirs = Object.entries(localMap)
    .filter(([, v]) => v.kind === 'directory')
    .sort((a, b) => a[0].split('/').length - b[0].split('/').length);

  for (const [path] of localDirs) {
    if (driveMap[path]) {
      manifest[path] = { ...(manifest[path] || {}), driveFolderId: driveMap[path].id };
      continue;
    }
    try {
      const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      const parentId = parentPath ? (manifest[parentPath]?.driveFolderId || driveMap[parentPath]?.id) : link.driveFolderId;
      const newId = await driveCreateFolder(macroUrl, path.split('/').pop(), parentId || link.driveFolderId);
      driveMap[path] = { kind: 'directory', id: newId };
      manifest[path] = { ...(manifest[path] || {}), driveFolderId: newId };
      summary.foldersCreated++;
      log(`Created Drive folder: ${path}`);
    } catch (err) {
      summary.errors++;
      log(`⚠ Couldn't create Drive folder "${path}": ${err.message}`);
    }
  }

  // --- Directories: Drive -> local (only ones we've never seen before) ---
  const driveDirs = Object.entries(driveMap)
    .filter(([, v]) => v.kind === 'directory')
    .sort((a, b) => a[0].split('/').length - b[0].split('/').length);

  for (const [path, info] of driveDirs) {
    if (localMap[path] || manifest[path]) continue;
    try {
      const parts = path.split('/');
      let dir = link.dirHandle;
      for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
      localMap[path] = { kind: 'directory', handle: dir };
      manifest[path] = { ...(manifest[path] || {}), driveFolderId: info.id };
      summary.foldersCreated++;
      log(`Created device folder: ${path}`);
    } catch (err) {
      summary.errors++;
      log(`⚠ Couldn't create device folder "${path}": ${err.message}`);
    }
  }

  // --- Files present locally ---
  const localFiles = Object.entries(localMap).filter(([, v]) => v.kind === 'file');
  for (const [path, info] of localFiles) {
    const driveEntry = driveMap[path];
    const manifestEntry = manifest[path];
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const parentDriveId = parentPath ? (manifest[parentPath]?.driveFolderId || driveMap[parentPath]?.id) : link.driveFolderId;

    try {
      if (!manifestEntry && !driveEntry) {
        // Brand new file, nowhere else — upload it.
        const file = await info.handle.getFile();
        const result = await driveUploadFile(macroUrl, file, parentDriveId, file.name);
        manifest[path] = { driveFileId: result.id, lastLocalMTime: info.lastModified, lastDriveModifiedTime: result.modifiedTime || Date.now() };
        summary.uploaded++;
        log(`Uploaded: ${path}`);

      } else if (!manifestEntry && driveEntry) {
        // Same name exists on both sides but was never linked — real conflict.
        const file = await info.handle.getFile();
        const renamed = renameWithSuffix(file.name, 'device');
        const result = await driveUploadFile(macroUrl, file, parentDriveId, renamed);
        manifest[path] = { driveFileId: result.id, lastLocalMTime: info.lastModified, lastDriveModifiedTime: result.modifiedTime || Date.now() };
        summary.renamedConflicts++;
        log(`Conflict on "${path}" — kept both, uploaded device copy as "${renamed}"`);

      } else {
        const localChanged = info.lastModified > (manifestEntry.lastLocalMTime || 0);
        const driveChanged = !!driveEntry && (driveEntry.modifiedTime || 0) > (manifestEntry.lastDriveModifiedTime || 0);

        if (localChanged && driveChanged) {
          const file = await info.handle.getFile();
          const renamed = renameWithSuffix(file.name, 'device-edit');
          const result = await driveUploadFile(macroUrl, file, parentDriveId, renamed);
          summary.renamedConflicts++;
          log(`Conflict on "${path}" — changed on both sides, kept both (device edit saved as "${renamed}")`);
          const dl = await driveDownloadFile(macroUrl, driveEntry.id);
          await writeLocalFile(link.dirHandle, path, dl.fileData, dl.mimeType);
          manifest[path] = { driveFileId: driveEntry.id, lastLocalMTime: Date.now(), lastDriveModifiedTime: dl.modifiedTime };
          void result;

        } else if (localChanged) {
          const file = await info.handle.getFile();
          const result = await driveUpdateFile(macroUrl, manifestEntry.driveFileId, file);
          manifest[path] = { driveFileId: result.id || manifestEntry.driveFileId, lastLocalMTime: info.lastModified, lastDriveModifiedTime: result.modifiedTime || Date.now() };
          summary.updatedOnDrive++;
          log(`Updated on Drive: ${path}`);

        } else if (driveChanged) {
          const dl = await driveDownloadFile(macroUrl, driveEntry.id);
          await writeLocalFile(link.dirHandle, path, dl.fileData, dl.mimeType);
          manifest[path] = { driveFileId: driveEntry.id, lastLocalMTime: Date.now(), lastDriveModifiedTime: dl.modifiedTime };
          summary.updatedLocal++;
          log(`Updated on device: ${path}`);

        } else {
          summary.skipped++;
        }
      }
    } catch (err) {
      summary.errors++;
      log(`⚠ Error syncing "${path}": ${err.message}`);
    }
  }

  // --- Files that only exist in Drive and were never synced before ---
  const driveFiles = Object.entries(driveMap).filter(([, v]) => v.kind === 'file');
  for (const [path, info] of driveFiles) {
    if (localMap[path]) continue; // already handled above
    if (manifest[path]) continue; // was deleted locally after a previous sync — leave Drive copy alone
    try {
      const dl = await driveDownloadFile(macroUrl, info.id);
      await writeLocalFile(link.dirHandle, path, dl.fileData, dl.mimeType);
      manifest[path] = { driveFileId: info.id, lastLocalMTime: Date.now(), lastDriveModifiedTime: info.modifiedTime };
      summary.downloaded++;
      log(`Downloaded: ${path}`);
    } catch (err) {
      summary.errors++;
      log(`⚠ Error downloading "${path}": ${err.message}`);
    }
  }

  await idbSet(MANIFEST_KEY, manifest);
  link.lastSyncedAt = Date.now();
  await idbSet(LINK_KEY, link);

  return summary;
}

// ---------- local filesystem helpers ----------

async function walkLocal(dirHandle, basePath = '') {
  const out = {};
  for await (const [name, handle] of dirHandle.entries()) {
    const path = basePath ? `${basePath}/${name}` : name;
    if (handle.kind === 'file') {
      const file = await handle.getFile();
      out[path] = { kind: 'file', handle, lastModified: file.lastModified, size: file.size };
    } else if (handle.kind === 'directory') {
      out[path] = { kind: 'directory', handle };
      Object.assign(out, await walkLocal(handle, path));
    }
  }
  return out;
}

async function writeLocalFile(rootHandle, relPath, base64Data, mimeType) {
  const parts = relPath.split('/');
  const fileName = parts.pop();
  let dir = rootHandle;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  const byteChars = atob(base64Data);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  await writable.write(new Blob([bytes], { type: mimeType || 'application/octet-stream' }));
  await writable.close();
}

async function verifyPermission(handle, readWrite) {
  const opts = readWrite ? { mode: 'readwrite' } : {};
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if ((await handle.requestPermission(opts)) === 'granted') return true;
  return false;
}

// ---------- Drive backend helpers ----------

async function walkDrive(macroUrl, folderId, basePath = '') {
  const out = {};
  const resp = await fetch(`${macroUrl}?${new URLSearchParams({ action: 'fetchItems', folderId })}`);
  const data = await resp.json();
  if (data.result !== 'success') throw new Error(data.message || 'Failed to list Drive folder');
  for (const item of data.items) {
    const path = basePath ? `${basePath}/${item.name}` : item.name;
    if (item.type === 'folder') {
      out[path] = { kind: 'directory', id: item.id };
      Object.assign(out, await walkDrive(macroUrl, item.id, path));
    } else {
      out[path] = { kind: 'file', id: item.id, mimeType: item.type, size: item.size, modifiedTime: item.modifiedTime || 0 };
    }
  }
  return out;
}

async function findOrCreateDriveFolder(macroUrl, folderName, parentFolderId) {
  const resp = await fetch(`${macroUrl}?${new URLSearchParams({ action: 'fetchItems', folderId: parentFolderId })}`);
  const data = await resp.json();
  if (data.result === 'success') {
    const match = data.items.find((i) => i.type === 'folder' && i.name === folderName);
    if (match) return match.id;
  }
  return driveCreateFolder(macroUrl, folderName, parentFolderId);
}

async function driveCreateFolder(macroUrl, folderName, parentFolderId) {
  const resp = await fetch(macroUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ action: 'createFolder', folderName, parentFolderId: parentFolderId || '' }),
  });
  const data = await resp.json();
  if (data.result !== 'success') throw new Error(data.message || 'Failed to create Drive folder');
  return data.folderId || data.id;
}

async function driveUploadFile(macroUrl, file, targetFolderId, fileName) {
  const base64 = await fileToBase64(file);
  const resp = await fetch(macroUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      fileData: base64,
      mimeType: file.type || 'application/octet-stream',
      fileName: fileName || file.name,
      targetFolderId: targetFolderId || '',
    }),
  });
  const data = await resp.json();
  if (data.result !== 'success') throw new Error(data.message || 'Upload failed');
  return data;
}

async function driveUpdateFile(macroUrl, fileId, file) {
  const base64 = await fileToBase64(file);
  const resp = await fetch(macroUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      action: 'updateFile',
      fileId,
      fileData: base64,
      mimeType: file.type || 'application/octet-stream',
      fileName: file.name,
    }),
  });
  const data = await resp.json();
  if (data.result !== 'success') throw new Error(data.message || 'Update failed');
  return data;
}

async function driveDownloadFile(macroUrl, fileId) {
  const resp = await fetch(`${macroUrl}?${new URLSearchParams({ action: 'downloadFile', fileId })}`);
  const data = await resp.json();
  if (data.result !== 'success') throw new Error(data.message || 'Download failed');
  return data;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function renameWithSuffix(name, suffix) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name} (${suffix})`;
  return `${name.slice(0, dot)} (${suffix})${name.slice(dot)}`;
}

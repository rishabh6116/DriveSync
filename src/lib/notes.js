// Notes are stored as plain .txt files inside a dedicated "Notes" folder in
// the user's Drive (created automatically the first time it's needed). Each
// note's filename (minus ".txt") is its title; the file's content is the
// note body. This piggybacks entirely on the existing Apps Script actions
// (fetchItems, createFolder, updateTextFile, renameItem, deleteItem,
// downloadFile) — no new backend action required.

const NOTES_FOLDER_NAME = 'Notes';

// ---------- text <-> base64 (UTF-8 safe) ----------

export function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToUtf8(b64) {
  const binary = atob(b64 || '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---------- filename <-> title ----------

export function sanitizeTitle(title) {
  const cleaned = (title || '').trim().replace(/[\\/:*?"<>|]/g, '-');
  return cleaned || 'Untitled';
}

export function titleFromFileName(fileName) {
  return fileName.replace(/\.txt$/i, '');
}

// ---------- Drive calls ----------

export async function ensureNotesFolder(macroUrl, rootFolderId) {
  const resp = await fetch(`${macroUrl}?${new URLSearchParams({ action: 'fetchItems', folderId: rootFolderId })}`);
  const data = await resp.json();
  if (data.result !== 'success') throw new Error(data.message || 'Failed to check for Notes folder');
  const existing = data.items.find((i) => i.type === 'folder' && i.name === NOTES_FOLDER_NAME);
  if (existing) return existing.id;

  const createResp = await fetch(macroUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ action: 'createFolder', folderName: NOTES_FOLDER_NAME, parentFolderId: rootFolderId }),
  });
  const createData = await createResp.json();
  if (createData.result !== 'success') throw new Error(createData.message || 'Failed to create Notes folder');
  return createData.folderId || createData.id;
}

export async function listNotes(macroUrl, notesFolderId) {
  const resp = await fetch(`${macroUrl}?${new URLSearchParams({ action: 'fetchItems', folderId: notesFolderId })}`);
  const data = await resp.json();
  if (data.result !== 'success') throw new Error(data.message || 'Failed to load notes');
  return data.items
    .filter((i) => i.type !== 'folder')
    .map((i) => ({ id: i.id, title: titleFromFileName(i.name), modifiedTime: i.modifiedTime || 0 }))
    .sort((a, b) => b.modifiedTime - a.modifiedTime);
}

export async function loadNoteContent(macroUrl, fileId) {
  const resp = await fetch(`${macroUrl}?${new URLSearchParams({ action: 'downloadFile', fileId })}`);
  const data = await resp.json();
  if (data.result !== 'success') throw new Error(data.message || 'Failed to open note');
  return base64ToUtf8(data.fileData);
}

export async function createNote(macroUrl, notesFolderId, title, content) {
  const fileName = `${sanitizeTitle(title)}.txt`;
  const resp = await fetch(macroUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      fileData: utf8ToBase64(content || ''),
      mimeType: 'text/plain',
      fileName,
      targetFolderId: notesFolderId,
    }),
  });
  const data = await resp.json();
  if (data.result !== 'success') throw new Error(data.message || 'Failed to save note');
  return { id: data.id, title: titleFromFileName(data.name || fileName), modifiedTime: data.modifiedTime || Date.now() };
}

export async function saveNoteContent(macroUrl, fileId, title, content) {
  const fileName = `${sanitizeTitle(title)}.txt`;
  const resp = await fetch(macroUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      action: 'updateTextFile',
      fileId,
      content: content || '',
      fileName,
    }),
  });
  const data = await resp.json();
  if (data.result !== 'success') throw new Error(data.message || 'Failed to save note');
  return { id: data.id || fileId, modifiedTime: data.modifiedTime || Date.now() };
}

export async function renameNote(macroUrl, fileId, newTitle) {
  const resp = await fetch(macroUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ action: 'renameItem', itemId: fileId, itemType: 'file', newName: `${sanitizeTitle(newTitle)}.txt` }),
  });
  const data = await resp.json();
  if (data.result !== 'success') throw new Error(data.message || 'Failed to rename note');
  return data;
}

export async function deleteNote(macroUrl, fileId) {
  const resp = await fetch(macroUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ action: 'deleteItem', itemId: fileId, itemType: 'file' }),
  });
  const data = await resp.json();
  if (data.result !== 'success') throw new Error(data.message || 'Failed to delete note');
}

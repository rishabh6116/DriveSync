// Builds the Google Apps Script "bridge" code with the user's Drive folder ID
// already filled in. Shown on the Register page once a folder link is pasted.
//
// NOTE: the template must not contain backticks or "${" (it lives in a JS template literal).

const TEMPLATE = `// DriveSync bridge
// Only the folder below (and everything inside it) can be accessed.
var ROOT_FOLDER_ID = '__FOLDER_ID__';

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function fail_(msg) {
  return json_({ result: 'error', message: String(msg) });
}

function isInsideRoot_(item) {
  var cur = item;
  for (var i = 0; i < 50; i++) {
    var parents = cur.getParents();
    if (!parents.hasNext()) return false;
    cur = parents.next();
    if (cur.getId() === ROOT_FOLDER_ID) return true;
  }
  return false;
}

function getFolder_(id) {
  id = id || ROOT_FOLDER_ID;
  var folder = DriveApp.getFolderById(id);
  if (id !== ROOT_FOLDER_ID && !isInsideRoot_(folder)) {
    throw new Error('Folder is outside the allowed root.');
  }
  return folder;
}

function getItem_(id, type) {
  if (id === ROOT_FOLDER_ID) throw new Error('Root folder cannot be modified.');
  var item = type === 'folder' ? DriveApp.getFolderById(id) : DriveApp.getFileById(id);
  if (!isInsideRoot_(item)) throw new Error('Item is outside the allowed root.');
  return item;
}

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};

    if (p.action === 'getStorageInfo') {
      var GB = 1073741824;
      return json_({
        result: 'success',
        storageUsed: (DriveApp.getStorageUsed() / GB).toFixed(2),
        storageTotal: Math.round(DriveApp.getStorageLimit() / GB)
      });
    }

    if (p.action === 'fetchItems') {
      var folderId = p.folderId || ROOT_FOLDER_ID;
      var folder = getFolder_(folderId);
      var items = [];

      var subs = folder.getFolders();
      while (subs.hasNext()) {
        var sf = subs.next();
        items.push({
          id: sf.getId(), name: sf.getName(), type: 'folder', size: 0,
          url: sf.getUrl(), modifiedTime: sf.getLastUpdated().toISOString()
        });
      }

      var files = folder.getFiles();
      while (files.hasNext()) {
        var f = files.next();
        items.push({
          id: f.getId(), name: f.getName(), type: f.getMimeType(), size: f.getSize(),
          url: f.getUrl(), modifiedTime: f.getLastUpdated().toISOString()
        });
      }

      var parentId = null;
      if (folderId !== ROOT_FOLDER_ID) {
        var ps = folder.getParents();
        if (ps.hasNext()) parentId = ps.next().getId();
      }

      return json_({
        result: 'success', items: items,
        currentFolderId: folderId, parentFolderId: parentId
      });
    }

    return json_({ result: 'success', message: 'DriveSync bridge is running' });
  } catch (err) {
    return fail_(err.message);
  }
}

function doPost(e) {
  try {
    var p = (e && e.parameter) || {};

    // File upload
    if (p.fileData) {
      var target = getFolder_(p.targetFolderId);
      var bytes = Utilities.base64Decode(p.fileData);
      var blob = Utilities.newBlob(bytes, p.mimeType || 'application/octet-stream', p.fileName);
      var file = target.createFile(blob);
      return json_({ result: 'success', fileId: file.getId() });
    }

    if (p.action === 'createFolder') {
      var parent = getFolder_(p.parentFolderId);
      var created = parent.createFolder(p.folderName);
      return json_({ result: 'success', folderId: created.getId() });
    }

    if (p.action === 'deleteItem') {
      getItem_(p.itemId, p.itemType).setTrashed(true);
      return json_({ result: 'success' });
    }

    if (p.action === 'renameItem') {
      getItem_(p.itemId, p.itemType).setName(p.newName);
      return json_({ result: 'success' });
    }

    return fail_('Unknown action.');
  } catch (err) {
    return fail_(err.message);
  }
}
`;

export function buildDriveScript(folderId) {
    return TEMPLATE.replace('__FOLDER_ID__', folderId);
}

// A Drive folder ID is a long run of letters, digits, "-" and "_".
export function looksLikeFolderId(value) {
    return /^[A-Za-z0-9_-]{15,}$/.test(value);
}

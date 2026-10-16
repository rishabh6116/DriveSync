const ROOT_FOLDER_ID = "your_folder_id";

function doGet(e) {
  try {
    const p = e.parameter;

    if (p.action === "fetchItems" || p.action === "list") {
      const targetId = p.folderId || ROOT_FOLDER_ID;
      const currentFolder = DriveApp.getFolderById(targetId);

      const folders = [];
      const subFolders = currentFolder.getFolders();
      while (subFolders.hasNext()) {
        const sf = subFolders.next();
        folders.push({
          id: sf.getId(),
          name: sf.getName(),
          type: "folder",
          size: 0,
          modifiedTime: sf.getLastUpdated().getTime()
        });
      }

      const files = [];
      const folderFiles = currentFolder.getFiles();
      while (folderFiles.hasNext()) {
        const f = folderFiles.next();
        files.push({
          id: f.getId(),
          name: f.getName(),
          type: f.getMimeType(),
          size: f.getSize(),
          url: f.getUrl(),
          modifiedTime: f.getLastUpdated().getTime()
        });
      }

      let parentFolderId = null;
      if (targetId !== ROOT_FOLDER_ID) {
        const parents = currentFolder.getParents();
        parentFolderId = parents.hasNext() ? parents.next().getId() : null;
      }

      return ContentService.createTextOutput(JSON.stringify({
        result: "success",
        currentFolderId: targetId,
        parentFolderId: parentFolderId,
        items: folders.concat(files)
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // Storage quota used to be fetched on every fetchItems call (i.e. on
    // every single folder navigation), which meant every click paid for a
    // DriveApp.getStorageUsed()/getStorageLimit() round trip it didn't need.
    // Split out into its own action so the frontend can fetch it once after
    // login and refresh it occasionally instead.
    if (p.action === "getStorageInfo") {
      const used = DriveApp.getStorageUsed();
      const limit = DriveApp.getStorageLimit();
      return ContentService.createTextOutput(JSON.stringify({
        result: "success",
        storageUsed: (used / (1024 * 1024 * 1024)).toFixed(1),
        storageTotal: (limit / (1024 * 1024 * 1024)).toFixed(0)
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // Used by the Notes feature to pull a note file's bytes back down
    // to read its content.
    if (p.action === "downloadFile") {
      const file = DriveApp.getFileById(p.fileId);
      const blob = file.getBlob();
      return ContentService.createTextOutput(JSON.stringify({
        result: "success",
        fileData: Utilities.base64Encode(blob.getBytes()),
        mimeType: file.getMimeType(),
        fileName: file.getName(),
        size: file.getSize(),
        modifiedTime: file.getLastUpdated().getTime()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    return HtmlService.createHtmlOutput("DriveSync Backend Service is Active.");

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      result: "error",
      message: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  try {
    const p = e.parameter;

    if (p.action === "createFolder") {
      const parentFolder = DriveApp.getFolderById(p.parentFolderId || ROOT_FOLDER_ID);
      const newFolder = parentFolder.createFolder(p.folderName);
      return ContentService.createTextOutput(JSON.stringify({
        result: "success",
        id: newFolder.getId(),
        folderId: newFolder.getId()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    if (p.action === "deleteItem") {
      if (p.itemType === "folder") {
        DriveApp.getFolderById(p.itemId).setTrashed(true);
      } else {
        DriveApp.getFileById(p.itemId).setTrashed(true);
      }
      return ContentService.createTextOutput(JSON.stringify({ result: "success" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (p.action === "renameItem") {
      const newName = (p.newName || "").trim();
      if (!newName) {
        return ContentService.createTextOutput(JSON.stringify({
          result: "error",
          message: "New name cannot be empty."
        })).setMimeType(ContentService.MimeType.JSON);
      }
      if (p.itemType === "folder") {
        const folder = DriveApp.getFolderById(p.itemId);
        folder.setName(newName);
        return ContentService.createTextOutput(JSON.stringify({
          result: "success",
          id: folder.getId(),
          name: folder.getName(),
          modifiedTime: folder.getLastUpdated().getTime()
        })).setMimeType(ContentService.MimeType.JSON);
      } else {
        const file = DriveApp.getFileById(p.itemId);
        file.setName(newName);
        return ContentService.createTextOutput(JSON.stringify({
          result: "success",
          id: file.getId(),
          name: file.getName(),
          modifiedTime: file.getLastUpdated().getTime()
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }

    // Used by the Notes feature to update a note's title/content in one
    // shot. Notes are always plain text, so this can update the file
    // content directly (File.setContent) without needing the Drive API
    // advanced service or any trash-and-recreate fallback — it always
    // edits the same file in place, so it can never create a duplicate.
    if (p.action === "updateTextFile") {
      const file = DriveApp.getFileById(p.fileId);
      file.setContent(p.content || "");
      if (p.fileName && p.fileName !== file.getName()) {
        file.setName(p.fileName);
      }
      return ContentService.createTextOutput(JSON.stringify({
        result: "success",
        id: file.getId(),
        name: file.getName(),
        modifiedTime: file.getLastUpdated().getTime()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    const uploadFolder = DriveApp.getFolderById(p.targetFolderId || ROOT_FOLDER_ID);
    const decodedData = Utilities.base64Decode(p.fileData);
    const blob = Utilities.newBlob(decodedData, p.mimeType, p.fileName);
    const uploadedFile = uploadFolder.createFile(blob);

    // DriveSync's preview popup loads images/PDFs through Google's *public*
    // thumbnail/embed endpoints (drive.google.com/thumbnail, /preview).
    // Those only work if the file itself is shared "Anyone with the link" —
    // a brand new file created here inherits the account's default sharing,
    // which can be private. Force it open here so every freshly uploaded
    // file previews correctly right away.
    try {
      uploadedFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (err) {
      // Some managed/Workspace accounts restrict link-sharing — the upload
      // itself still succeeds either way, so don't fail the request over it.
    }

    return ContentService.createTextOutput(JSON.stringify({
      result: "success",
      id: uploadedFile.getId(),
      name: uploadedFile.getName(),
      type: uploadedFile.getMimeType(),
      size: uploadedFile.getSize(),
      url: uploadedFile.getUrl(),
      modifiedTime: uploadedFile.getLastUpdated().getTime()
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      result: "error",
      message: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ---------------------------------------------------------------------
// One-time maintenance: walks every file already sitting in the Drive
// tree and makes sure it's shared "Anyone with the link can view", so
// DriveSync's public preview thumbnails/embeds work for it. New uploads
// get this automatically (see doPost above) — this is only needed once
// to backfill files that were already there before that fix, or any
// file added a different way (dragged into Drive directly, etc).
//
// How to run it: open this project at script.google.com, pick
// "fixAllFilePermissions" from the function dropdown in the toolbar,
// click Run, and approve the permission prompt if asked. Check
// View → Logs afterwards for a summary. Safe to re-run any time.
// ---------------------------------------------------------------------
function fixAllFilePermissions() {
  let fixed = 0;
  let skipped = 0;

  function walk(folder) {
    const files = folder.getFiles();
    while (files.hasNext()) {
      const file = files.next();
      try {
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        fixed++;
      } catch (err) {
        skipped++;
        Logger.log("Could not update sharing for " + file.getName() + ": " + err);
      }
    }

    const subFolders = folder.getFolders();
    while (subFolders.hasNext()) {
      walk(subFolders.next());
    }
  }

  walk(DriveApp.getFolderById(ROOT_FOLDER_ID));
  Logger.log("Done. Fixed: " + fixed + ", skipped: " + skipped);
}

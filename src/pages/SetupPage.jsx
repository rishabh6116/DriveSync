import { useLayoutEffect, useMemo, useState } from 'react';
import pageCss from '../styles/setup.page.css?raw';

const SETUP_SCRIPT = `const ROOT_FOLDER_ID = "your_folder_id";

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
`;

function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlight(code) {
    const escaped = escapeHtml(code);
    const pattern = /(\/\/.*$)|("(?:[^"\\]|\\.)*")|\b(function|const|let|var|if|else|return|while|try|catch|throw|new)\b|\b(DriveApp|Drive|ContentService|HtmlService|Utilities|JSON)\b|\b([a-zA-Z_]\w*)(?=\()|\b(\d+)\b/gm;
    return escaped.replace(pattern, (match, comment, str, kw, api, fn, num) => {
        if (comment) return `<span class="tok-cm">${comment}</span>`;
        if (str) return `<span class="tok-str">${str}</span>`;
        if (kw) return `<span class="tok-kw">${kw}</span>`;
        if (api) return `<span class="tok-prop">${api}</span>`;
        if (fn) return `<span class="tok-fn">${fn}</span>`;
        if (num) return `<span class="tok-num">${num}</span>`;
        return match;
    });
}

export default function SetupPage() {
    const [copied, setCopied] = useState(false);

    useLayoutEffect(() => {
        const styleEl = document.createElement('style');
        styleEl.setAttribute('data-page', 'setup');
        styleEl.textContent = pageCss;
        document.head.appendChild(styleEl);
        return () => styleEl.remove();
    }, []);

    const lines = useMemo(() => SETUP_SCRIPT.replace(/\n$/, '').split('\n'), []);
    const highlightedHtml = useMemo(() => highlight(SETUP_SCRIPT.replace(/\n$/, '')), []);

    async function handleCopy() {
        try {
            await navigator.clipboard.writeText(SETUP_SCRIPT);
        } catch {
            // Fallback for browsers/webviews without Clipboard API access
            const textarea = document.createElement('textarea');
            textarea.value = SETUP_SCRIPT;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }

    return (
        <div className="setup-page">
            <div className="setup-shell">
                <div className="su-topbar">
                    <a className="su-brand" href="/">
                        <span className="su-brand-icon"><img src="/android-chrome-192x192.png?v=3" alt="DriveSync" /></span>
                        <span className="su-brand-name">DriveSync</span>
                    </a>
                    <a className="su-back-link" href="/"><i className="ti ti-arrow-left"></i> Back to app</a>
                </div>

                <div className="su-hero">
                    <span className="su-eyebrow"><span className="su-status-dot"></span> SETUP GUIDE</span>
                    <h1>Wire up your own <em>Drive backend</em></h1>
                    <p>DriveSync doesn't store your files — it talks to a small Google Apps Script deployed on your own Drive. Six steps, about five minutes, and it's yours.</p>
                </div>

                <div className="su-callout">
                    <i className="ti ti-info-circle"></i>
                    <div>
                        <div className="su-callout-title">Before you start</div>
                        <p>You'll need a Google account with Drive access, and a folder you want DriveSync to read from — right-click it in Drive and copy the ID out of the URL (the part after <code>folders/</code>).</p>
                    </div>
                </div>

                <div className="su-steps">
                    <div className="su-step">
                        <div className="su-step-num">01</div>
                        <div className="su-step-body">
                            <h3>Create the Apps Script project</h3>
                            <p>Go to <a href="https://script.google.com" target="_blank" rel="noopener noreferrer">script.google.com</a> → <strong>New project</strong>. Give it a name like <span className="su-inline-code">DriveSync Backend</span> so it's easy to find later.</p>
                        </div>
                    </div>

                    <div className="su-step">
                        <div className="su-step-num">02</div>
                        <div className="su-step-body">
                            <h3>Paste the backend script</h3>
                            <p>Delete the placeholder <span className="su-inline-code">Code.gs</span> content and paste this in exactly as-is.</p>

                            <div className="su-editor">
                                <div className="su-editor-titlebar">
                                    <div className="su-editor-dots"><span></span><span></span><span></span></div>
                                    <div className="su-editor-filename"><i className="ti ti-brand-javascript"></i> Code.gs</div>
                                    <button
                                        type="button"
                                        className={`su-copy-btn${copied ? ' copied' : ''}`}
                                        onClick={handleCopy}
                                    >
                                        <i className={`ti ${copied ? 'ti-check' : 'ti-copy'}`}></i>
                                        {copied ? 'Copied' : 'Copy script'}
                                    </button>
                                </div>
                                <div className="su-editor-body">
                                    <div className="su-line-numbers">
                                        {lines.map((_, i) => <div key={i}>{i + 1}</div>)}
                                    </div>
                                    <pre className="su-code"><code dangerouslySetInnerHTML={{ __html: highlightedHtml }} /></pre>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="su-step">
                        <div className="su-step-num">03</div>
                        <div className="su-step-body">
                            <h3>Swap in your folder ID</h3>
                            <p>On line 1, replace <span className="su-inline-code">your_folder_id</span> with the Drive folder ID you copied earlier. This is the folder DriveSync will treat as the root of your drive.</p>
                        </div>
                    </div>

                    <div className="su-step">
                        <div className="su-step-num">04</div>
                        <div className="su-step-body">
                            <h3>Deploy as a web app</h3>
                            <p>Click <strong>Deploy → New deployment</strong>, choose type <strong>Web app</strong>, set <strong>Execute as</strong> to yourself and <strong>Who has access</strong> to <strong>Anyone</strong>, then click <strong>Deploy</strong>. Approve the permissions Google asks for — this script only touches the one folder you point it at.</p>
                        </div>
                    </div>

                    <div className="su-step">
                        <div className="su-step-num">05</div>
                        <div className="su-step-body">
                            <h3>Copy the deployment URL</h3>
                            <p>After deploying, Google gives you a URL ending in <span className="su-inline-code">/exec</span>. That's your macro URL — copy it.</p>
                        </div>
                    </div>

                    <div className="su-step">
                        <div className="su-step-num">06</div>
                        <div className="su-step-body">
                            <h3>Connect it in DriveSync</h3>
                            <p>Open <strong>Admin → Add Account</strong>, paste the macro URL and the folder ID from step 3, set the login email and a password, and save. Signing in with that email and password is what unlocks this drive inside DriveSync. Need to swap in a different macro URL later? You can update it anytime from <strong>Change Password</strong> inside the app — no need to re-add the account.</p>
                        </div>
                    </div>
                </div>

                <div className="su-ref">
                    <h2>What the script does</h2>
                    <p>A quick reference for the actions this backend understands.</p>
                    <div className="su-ref-table">
                        <div className="su-ref-row head">
                            <div>Method</div>
                            <div>Action</div>
                            <div>Does</div>
                        </div>
                        <div className="su-ref-row">
                            <span className="su-ref-method get">GET</span>
                            <span className="su-ref-action">fetchItems</span>
                            <span className="su-ref-desc">Lists folders and files inside a given folder.</span>
                        </div>
                        <div className="su-ref-row">
                            <span className="su-ref-method get">GET</span>
                            <span className="su-ref-action">getStorageInfo</span>
                            <span className="su-ref-desc">Returns current Drive storage usage — fetched separately from fetchItems so folder navigation doesn't pay for a quota lookup every time.</span>
                        </div>
                        <div className="su-ref-row">
                            <span className="su-ref-method get">GET</span>
                            <span className="su-ref-action">downloadFile</span>
                            <span className="su-ref-desc">Returns a file's raw content as base64 — used by the Notes feature to read a note's content.</span>
                        </div>
                        <div className="su-ref-row">
                            <span className="su-ref-method post">POST</span>
                            <span className="su-ref-action">createFolder</span>
                            <span className="su-ref-desc">Creates a new subfolder inside the given parent folder.</span>
                        </div>
                        <div className="su-ref-row">
                            <span className="su-ref-method post">POST</span>
                            <span className="su-ref-action">deleteItem</span>
                            <span className="su-ref-desc">Moves a file or folder to Trash.</span>
                        </div>
                        <div className="su-ref-row">
                            <span className="su-ref-method post">POST</span>
                            <span className="su-ref-action">renameItem</span>
                            <span className="su-ref-desc">Renames a file or folder in place.</span>
                        </div>
                        <div className="su-ref-row">
                            <span className="su-ref-method post">POST</span>
                            <span className="su-ref-action">updateTextFile</span>
                            <span className="su-ref-desc">Overwrites a plain-text file's content and name in place — used by the Notes feature.</span>
                        </div>
                        <div className="su-ref-row">
                            <span className="su-ref-method post">POST</span>
                            <span className="su-ref-action">(upload)</span>
                            <span className="su-ref-desc">Decodes a base64 file payload and saves it into the target folder.</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

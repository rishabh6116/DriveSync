import { useCallback, useEffect, useRef, useState } from 'react';
import { isSameTabSession } from '../lib/tabSession.js';
import {
    ensureNotesFolder, listNotes, loadNoteContent, createNote, saveNoteContent, deleteNote,
} from '../lib/notes.js';
import pageCss from '../styles/notes.page.css?raw';

function readSession() {
    const ok = sessionStorage.getItem('drivesync_authenticated') === 'true' && isSameTabSession();
    const macro = sessionStorage.getItem('drivesync_macro');
    const root = sessionStorage.getItem('drivesync_root');
    return ok && macro && root ? { macro, root } : null;
}

export default function NotesPage() {
    const session = useRef(readSession());
    const folderId = useRef(null);

    const [notes, setNotes] = useState([]);
    const [loading, setLoading] = useState(true);
    const [listError, setListError] = useState('');
    const [view, setView] = useState('list'); // 'list' | 'editor'
    const [noteId, setNoteId] = useState(null);
    const [title, setTitle] = useState('');
    const [content, setContent] = useState('');
    const [busy, setBusy] = useState(false);
    const [editorError, setEditorError] = useState('');
    const [status, setStatus] = useState('');
    const [armed, setArmed] = useState(false);
    const [toast, setToast] = useState('');

    useEffect(() => {
        const theme = localStorage.getItem('drivesync_theme') || 'dark';
        document.documentElement.setAttribute('data-theme', theme);
        const styleEl = document.createElement('style');
        styleEl.setAttribute('data-page', 'notes');
        styleEl.textContent = pageCss;
        document.head.appendChild(styleEl);
        return () => styleEl.remove();
    }, []);

    useEffect(() => {
        if (!session.current) window.location.replace('/');
    }, []);

    const showToast = useCallback((msg) => {
        setToast(msg);
        setTimeout(() => setToast(''), 2600);
    }, []);

    const refresh = useCallback(async () => {
        const s = session.current;
        if (!s) return;
        setLoading(true);
        setListError('');
        try {
            if (!folderId.current) folderId.current = await ensureNotesFolder(s.macro, s.root);
            setNotes(await listNotes(s.macro, folderId.current));
        } catch (err) {
            console.error(err);
            setListError(err.message || 'Unknown error');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    const openEditor = async (id) => {
        setView('editor');
        setNoteId(id);
        setEditorError('');
        setStatus('');
        setArmed(false);
        if (!id) { setTitle(''); setContent(''); return; }
        const meta = notes.find((n) => n.id === id);
        setTitle('Loading…');
        setContent('');
        setBusy(true);
        try {
            const text = await loadNoteContent(session.current.macro, id);
            setTitle(meta ? meta.title : '');
            setContent(text);
        } catch (err) {
            console.error(err);
            setTitle(meta ? meta.title : '');
            setEditorError("Couldn't load this note: " + err.message);
        } finally {
            setBusy(false);
        }
    };

    const backToList = async () => {
        setView('list');
        await refresh();
    };

    const save = async () => {
        const s = session.current;
        const cleanTitle = title.trim() || 'Untitled';
        setBusy(true);
        setEditorError('');
        try {
            if (!folderId.current) folderId.current = await ensureNotesFolder(s.macro, s.root);
            if (!noteId) {
                const created = await createNote(s.macro, folderId.current, cleanTitle, content);
                setNoteId(created.id);
            } else {
                const result = await saveNoteContent(s.macro, noteId, cleanTitle, content);
                setNoteId(result.id);
            }
            setStatus('Saved just now');
            showToast('Note saved.');
        } catch (err) {
            console.error(err);
            setEditorError('Failed to save: ' + err.message);
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!noteId) return;
        if (!armed) {
            setArmed(true);
            setTimeout(() => setArmed(false), 3000);
            return;
        }
        setBusy(true);
        try {
            await deleteNote(session.current.macro, noteId);
            showToast('Note deleted.');
            setNoteId(null);
            await backToList();
        } catch (err) {
            console.error(err);
            setEditorError('Failed to delete: ' + err.message);
        } finally {
            setBusy(false);
            setArmed(false);
        }
    };

    if (!session.current) return null;

    return (
        <div className="notes-page">
            <header className="np-topbar">
                <a className="np-back" href="/"><i className="ti ti-arrow-left" /> Drive</a>
                <h1><i className="ti ti-notes" /> Notes</h1>
                {view === 'list' && (
                    <button className="np-btn np-primary" onClick={() => openEditor(null)}>
                        <i className="ti ti-plus" /> New Note
                    </button>
                )}
            </header>

            <main className="np-content">
                {view === 'list' && (
                    <div className="np-grid">
                        {loading && <div className="np-empty"><div className="np-spinner" /></div>}
                        {!loading && listError && (
                            <div className="np-empty np-error">Couldn't load notes: {listError}</div>
                        )}
                        {!loading && !listError && notes.length === 0 && (
                            <div className="np-empty">No notes yet — tap "New Note" to add one.</div>
                        )}
                        {!loading && !listError && notes.map((n) => (
                            <button key={n.id} className="np-card" onClick={() => openEditor(n.id)}>
                                <div className="np-card-title">{n.title}</div>
                                <div className="np-card-date">
                                    {n.modifiedTime ? new Date(n.modifiedTime).toLocaleDateString() : ''}
                                </div>
                            </button>
                        ))}
                    </div>
                )}

                {view === 'editor' && (
                    <div className="np-editor">
                        <div className="np-editor-bar">
                            <button className="np-btn" onClick={backToList} disabled={busy}>
                                <i className="ti ti-arrow-left" /> Back
                            </button>
                            {noteId && (
                                <button className="np-btn np-danger" onClick={remove} disabled={busy} title="Delete note">
                                    {armed ? <><i className="ti ti-alert-triangle" /> Confirm?</> : <i className="ti ti-trash" />}
                                </button>
                            )}
                        </div>
                        <input
                            className="np-input np-title" type="text" placeholder="Title" autoComplete="off"
                            value={title} disabled={busy && title === 'Loading…'}
                            onChange={(e) => setTitle(e.target.value)}
                        />
                        <textarea
                            className="np-input np-text" placeholder="Start typing…"
                            value={content} disabled={busy && title === 'Loading…'}
                            onChange={(e) => setContent(e.target.value)}
                        />
                        {editorError && <div className="np-error-line">{editorError}</div>}
                        <div className="np-actions">
                            <span className="np-status">{status}</span>
                            <button className="np-btn np-primary" onClick={save} disabled={busy}>
                                {busy && title !== 'Loading…' ? 'Saving...' : 'Save'}
                            </button>
                        </div>
                    </div>
                )}
            </main>

            <div className={'np-toast' + (toast ? ' show' : '')}>{toast}</div>
        </div>
    );
}

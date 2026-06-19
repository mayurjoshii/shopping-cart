import React, { useState, useEffect, useCallback } from 'react';
import './App.css';

const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'm4v']);

function isVideo(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  return VIDEO_EXTS.has(ext);
}

function basename(filePath) {
  return filePath.split('/').pop();
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

export default function App() {
  const [files, setFiles] = useState([]);
  const [index, setIndex] = useState(0);
  const [toDelete, setToDelete] = useState(new Set());
  const [duplicates, setDuplicates] = useState(new Set());
  const [phase, setPhase] = useState('idle'); // idle | ready | reviewing | confirm | done
  const [flash, setFlash] = useState(null); // 'keep' | 'delete' | null
  const [returnTo, setReturnTo] = useState('done');
  const [fileInfo, setFileInfo] = useState(null);
  const [history, setHistory] = useState([]); // undo stack: [{ filePath, wasDeleted }]
  const [folderSummary, setFolderSummary] = useState(null); // { count, totalSize, dupCount }

  useEffect(() => {
    if (phase !== 'reviewing' || !files[index]) return;
    setFileInfo(null);
    window.pinder.getFileInfo(files[index]).then(setFileInfo);
  }, [phase, index, files]);

  const triggerFlash = useCallback((type) => {
    setFlash(type);
    setTimeout(() => setFlash(null), 300);
  }, []);

  useEffect(() => {
    if (phase !== 'reviewing') return;

    const handleKey = (e) => {
      if (e.key === 'ArrowRight') {
        triggerFlash('keep');
        setHistory((h) => [...h, { filePath: files[index], wasDeleted: false }]);
        setIndex((i) => {
          if (i + 1 >= files.length) { setReturnTo('done'); setPhase('confirm'); return i; }
          return i + 1;
        });
      } else if (e.key === 'ArrowLeft') {
        triggerFlash('delete');
        const newToDelete = new Set([...toDelete, files[index]]);
        setToDelete(newToDelete);
        setHistory((h) => [...h, { filePath: files[index], wasDeleted: true }]);
        if (newToDelete.size >= 50) {
          // Auto-pause: advance past current file then prompt review
          setIndex((i) => (i + 1 < files.length ? i + 1 : i));
          setReturnTo('reviewing');
          setPhase('confirm');
        } else {
          setIndex((i) => {
            if (i + 1 >= files.length) { setReturnTo('done'); setPhase('confirm'); return i; }
            return i + 1;
          });
        }
      } else if (e.key === 'z' || e.key === 'Z') {
        setHistory((h) => {
          if (!h.length) return h;
          const next = [...h];
          const last = next.pop();
          if (last.wasDeleted) {
            setToDelete((td) => { const n = new Set(td); n.delete(last.filePath); return n; });
          }
          setIndex((i) => Math.max(0, i - 1));
          return next;
        });
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [phase, index, files, toDelete, triggerFlash]);

  async function openFolder() {
    const result = await window.pinder.openFolder();
    if (!result || !result.paths.length) return;
    setFiles(result.paths);
    setDuplicates(new Set(result.duplicates));
    setFolderSummary({
      count: result.paths.length,
      totalSize: result.totalSize,
      dupCount: result.duplicates.length,
    });
    setIndex(0);
    setToDelete(new Set());
    setHistory([]);
    setPhase('ready');
  }

  function startReview() {
    setPhase('reviewing');
  }

  async function confirmTrash() {
    await window.pinder.deleteFiles([...toDelete]);
    if (returnTo === 'reviewing') {
      setToDelete(new Set());
      setPhase('reviewing');
    } else {
      setPhase('done');
    }
  }

  function cancelConfirm() {
    setPhase(returnTo === 'reviewing' ? 'reviewing' : 'done');
  }

  function openReviewMid() {
    setReturnTo('reviewing');
    setPhase('confirm');
  }

  function removeFromDelete(filePath) {
    setToDelete((prev) => {
      const next = new Set(prev);
      next.delete(filePath);
      return next;
    });
  }

  function restart() {
    setFiles([]);
    setIndex(0);
    setToDelete(new Set());
    setHistory([]);
    setFolderSummary(null);
    setDuplicates(new Set());
    setPhase('idle');
  }

  // ── Idle ──────────────────────────────────────────────
  if (phase === 'idle') {
    return (
      <div className="screen idle">
        <h1 className="logo">Pinder</h1>
        <p className="subtitle">Swipe through your photos and videos</p>
        <button className="btn-primary" onClick={openFolder}>
          Open Folder
        </button>
        <p className="hint">← delete &nbsp;&nbsp; → keep &nbsp;&nbsp; Z undo</p>
      </div>
    );
  }

  // ── Ready (folder summary) ────────────────────────────
  if (phase === 'ready' && folderSummary) {
    return (
      <div className="screen idle">
        <h1 className="logo">Ready</h1>
        <div className="summary-box">
          <div className="summary-row">
            <span className="summary-label">Files</span>
            <span className="summary-value">{folderSummary.count}</span>
          </div>
          <div className="summary-row">
            <span className="summary-label">Total size</span>
            <span className="summary-value">{formatSize(folderSummary.totalSize)}</span>
          </div>
          {folderSummary.dupCount > 0 && (
            <div className="summary-row">
              <span className="summary-label">Possible duplicates</span>
              <span className="summary-value summary-dup">{folderSummary.dupCount}</span>
            </div>
          )}
        </div>
        <button className="btn-primary" onClick={startReview}>
          Start Review
        </button>
        <button className="btn-secondary" onClick={restart} style={{ marginTop: 4 }}>
          Choose different folder
        </button>
      </div>
    );
  }

  // ── Reviewing ─────────────────────────────────────────
  if (phase === 'reviewing') {
    const current = files[index];
    const video = isVideo(current);
    const src = `file://${current}`;
    const isDuplicate = duplicates.has(current);

    return (
      <div className={`screen reviewing ${flash ? `flash-${flash}` : ''}`}>
        {toDelete.size > 0 && (
          <button className="review-flagged-btn" onClick={openReviewMid}>
            Review flagged ({toDelete.size})
          </button>
        )}
        <div className="counter">{index + 1} / {files.length}</div>
        {fileInfo && (
          <div className="file-info">
            <span className="file-info-name">{basename(files[index])}</span>
            {isDuplicate && <span className="dup-badge">Possible duplicate</span>}
            <span>{formatSize(fileInfo.size)}</span>
            <span>{formatDate(fileInfo.created)}</span>
          </div>
        )}
        {video ? (
          <video key={current} src={src} autoPlay loop muted className="media" />
        ) : (
          <img key={current} src={src} alt={basename(current)} className="media" />
        )}
        <div className="hint-bar">
          <span className="hint-delete">← trash</span>
          {history.length > 0 && <span className="hint-undo">Z undo</span>}
          <span className="hint-keep">keep →</span>
        </div>
      </div>
    );
  }

  // ── Confirm ───────────────────────────────────────────
  if (phase === 'confirm') {
    const deleteList = [...toDelete];
    const count = deleteList.length;
    return (
      <div className="screen confirm">
        <h2>
          {count === 0
            ? 'Nothing flagged'
            : count >= 50 && returnTo === 'reviewing'
            ? `50 files flagged — review before continuing`
            : `Move ${count} file${count !== 1 ? 's' : ''} to Trash?`}
        </h2>
        {count > 0 && (
          <div className="delete-grid">
            {deleteList.map((f) => (
              <div key={f} className="grid-thumb">
                {isVideo(f) ? (
                  <video src={`file://${f}`} muted />
                ) : (
                  <img src={`file://${f}`} alt={basename(f)} />
                )}
                <button className="remove-btn" onClick={() => removeFromDelete(f)} title="Un-flag">
                  ×
                </button>
                {duplicates.has(f) && <span className="thumb-dup-badge">dup</span>}
                <div className="thumb-name">{basename(f)}</div>
              </div>
            ))}
          </div>
        )}
        <div className="confirm-buttons">
          {count > 0 && (
            <button className="btn-danger" onClick={confirmTrash}>
              Move to Trash ({count})
            </button>
          )}
          <button className="btn-secondary" onClick={cancelConfirm}>
            {returnTo === 'reviewing' ? 'Back to review' : count === 0 ? 'Done' : 'Cancel — keep all'}
          </button>
        </div>
      </div>
    );
  }

  // ── Done ──────────────────────────────────────────────
  if (phase === 'done') {
    return (
      <div className="screen idle">
        <h1 className="logo">All done.</h1>
        <button className="btn-primary" onClick={restart}>
          Start over
        </button>
      </div>
    );
  }

  return null;
}

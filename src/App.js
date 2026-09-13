import React, { useState, useEffect, useCallback, useRef } from 'react';
import './App.css';

const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'm4v']);
const SWIPE_DURATION = 120; // ms — must match .swipe-exit-* animation duration (--duration-fast)
const TOAST_DURATION = 3200; // ms visible before dismissing
const BATCH_SIZE = 100; // filmstrip renders one batch at a time so huge folders stay smooth
const PREVIEW_WIDTH = 1600; // main review image is capped to this, plenty for any screen
const FILMSTRIP_THUMB_WIDTH = 112; // 2x the 56px CSS box, for retina
const GRID_THUMB_WIDTH = 300;

function isVideo(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  return VIDEO_EXTS.has(ext);
}

function isPdf(filePath) {
  return filePath.split('.').pop().toLowerCase() === 'pdf';
}

function mediaSrc(filePath) {
  return `pinder-media://local${encodeURI(filePath)}`;
}

// Downscaled copy of the same file — original bytes on disk are never
// touched, this only shrinks what gets decoded/composited in-app.
function thumbSrc(filePath, width) {
  return `pinder-thumb://local${encodeURI(filePath)}?w=${width}`;
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

let toastSeq = 0;
const CONFETTI_COLORS = ['var(--color-keep)', 'var(--color-accent)', 'var(--color-warning)', '#ff6b9d', '#4ecdc4'];
const CONFETTI_PIECES = Array.from({ length: 18 }, (_, i) => ({
  id: i,
  left: Math.random() * 100,
  delay: Math.random() * 0.15,
  duration: 0.7 + Math.random() * 0.4,
  color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
  rotate: Math.random() * 360,
}));

function Confetti() {
  return (
    <div className="confetti-burst" aria-hidden="true">
      {CONFETTI_PIECES.map((p) => (
        <span
          key={p.id}
          className="confetti-piece"
          style={{
            left: `${p.left}%`,
            background: p.color,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.duration}s`,
            transform: `rotate(${p.rotate}deg)`,
          }}
        />
      ))}
    </div>
  );
}

function DupThumb({ filePath, isKeep, onKeep }) {
  const [info, setInfo] = useState(null);

  useEffect(() => {
    let cancelled = false;
    window.pinder.getFileInfo(filePath).then((i) => { if (!cancelled) setInfo(i); });
    return () => { cancelled = true; };
  }, [filePath]);

  return (
    <div className={`dup-thumb${isKeep ? ' dup-thumb-keep' : ''}`} onClick={onKeep}>
      {isVideo(filePath) ? (
        <video src={mediaSrc(filePath)} muted />
      ) : isPdf(filePath) ? (
        <div className="grid-pdf-icon"><span role="img" aria-label="PDF document">📄</span></div>
      ) : (
        <img src={thumbSrc(filePath, GRID_THUMB_WIDTH)} alt={basename(filePath)} loading="lazy" />
      )}
      <div className="dup-thumb-info">
        <span className="thumb-name">{basename(filePath)}</span>
        {info && <span>{formatSize(info.size)} · {formatDate(info.created)}</span>}
      </div>
      {isKeep && <span className="dup-keep-badge">Keep</span>}
    </div>
  );
}

function ToastStack({ toasts, phase }) {
  if (!toasts.length) return null;
  return (
    <div className={`toast-stack${phase === 'reviewing' ? ' offset-for-review' : ''}`}>
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}${t.leaving ? ' leaving' : ''}`}>
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [files, setFiles] = useState([]);
  const [index, setIndex] = useState(0);
  const [toDelete, setToDelete] = useState(new Set());
  const [duplicates, setDuplicates] = useState(new Set());
  const [duplicateGroups, setDuplicateGroups] = useState([]); // [[path, path, ...], ...]
  const [dupDecisions, setDupDecisions] = useState({}); // groupIndex -> 'discard-all' | { keep: path } | undefined (= keep all)
  const [phase, setPhase] = useState('idle'); // idle | ready | duplicates | reviewing | confirm | done
  const [flash, setFlash] = useState(null); // 'keep' | 'delete' | null
  const [swipeDir, setSwipeDir] = useState(null); // 'left' | 'right' | null — card mid-flight
  const [returnTo, setReturnTo] = useState('done');
  const [fileInfo, setFileInfo] = useState(null);
  const [history, setHistory] = useState([]); // undo stack: [{ filePath, wasDeleted }]
  const [folderSummary, setFolderSummary] = useState(null); // { count, totalSize, dupGroupCount, dupFileCount }
  const [folderPath, setFolderPath] = useState(null);
  const [folderLoading, setFolderLoading] = useState(false);
  const [trashLoading, setTrashLoading] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [showConfetti, setShowConfetti] = useState(false);
  const filmstripRef = useRef(null);
  const activeThumbRef = useRef(null);

  const addToast = useCallback((message, type = 'info') => {
    const id = ++toastSeq;
    setToasts((prev) => [...prev, { id, message, type, leaving: false }]);
    setTimeout(() => {
      setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 180);
    }, TOAST_DURATION);
  }, []);

  useEffect(() => {
    if (phase !== 'reviewing' || !files[index]) return;
    setFileInfo(null);
    window.pinder.getFileInfo(files[index]).then(setFileInfo);
  }, [phase, index, files]);

  useEffect(() => {
    if (activeThumbRef.current) {
      activeThumbRef.current.scrollIntoView({
        behavior: 'smooth', inline: 'center', block: 'nearest',
      });
    }
  }, [index]);

  const triggerFlash = useCallback((type) => {
    setFlash(type);
    setTimeout(() => setFlash(null), 300);
  }, []);

  useEffect(() => {
    if (phase !== 'reviewing') return;

    const advance = () => {
      setIndex((i) => {
        if (i + 1 >= files.length) { setReturnTo('done'); setPhase('confirm'); return i; }
        return i + 1;
      });
    };

    const handleKey = (e) => {
      if (swipeDir) return; // ignore input while a card is mid-flight
      if (e.key === 'ArrowRight') {
        triggerFlash('keep');
        setSwipeDir('right');
        setTimeout(() => {
          setHistory((h) => [...h, { filePath: files[index], wasDeleted: false }]);
          advance();
          setSwipeDir(null);
        }, SWIPE_DURATION);
      } else if (e.key === 'ArrowLeft') {
        triggerFlash('delete');
        setSwipeDir('left');
        setTimeout(() => {
          const newToDelete = new Set([...toDelete, files[index]]);
          setToDelete(newToDelete);
          setHistory((h) => [...h, { filePath: files[index], wasDeleted: true }]);
          if (newToDelete.size >= 50) {
            // Auto-pause: advance past current file then prompt review
            setIndex((i) => (i + 1 < files.length ? i + 1 : i));
            setReturnTo('reviewing');
            setPhase('confirm');
          } else {
            advance();
          }
          setSwipeDir(null);
        }, SWIPE_DURATION);
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
  }, [phase, index, files, toDelete, swipeDir, triggerFlash]);

  async function openFolder() {
    setFolderLoading(true);
    try {
      const result = await window.pinder.openFolder();
      if (!result) return;
      if (!result.paths.length) {
        addToast('No photos or videos found in that folder', 'warning');
        return;
      }
      setFiles(result.paths);
      setFolderPath(result.folder);
      setDuplicateGroups(result.duplicateGroups);
      setDupDecisions({});
      setDuplicates(new Set(result.duplicateGroups.flat()));
      setFolderSummary({
        count: result.paths.length,
        totalSize: result.totalSize,
        dupGroupCount: result.duplicateGroups.length,
        dupFileCount: result.duplicateGroups.flat().length,
      });
      setIndex(0);
      setToDelete(new Set());
      setHistory([]);
      setPhase('ready');
    } finally {
      setFolderLoading(false);
    }
  }

  function startReview() {
    setPhase('reviewing');
  }

  function openDuplicates() {
    setPhase('duplicates');
  }

  function setDupDecision(groupIndex, decision) {
    setDupDecisions((prev) => ({ ...prev, [groupIndex]: decision }));
  }

  // Applies each group's decision (default: keep all, i.e. untouched) and
  // continues into normal swipe review with only the still-undecided files.
  function resolveDuplicatesAndContinue() {
    const removeFromReview = new Set();
    const newToDelete = new Set(toDelete);
    const remainingDuplicates = new Set();

    duplicateGroups.forEach((group, i) => {
      const decision = dupDecisions[i];
      if (!decision || decision === 'keep-all') {
        group.forEach((p) => remainingDuplicates.add(p));
        return;
      }
      if (decision === 'discard-all') {
        group.forEach((p) => { removeFromReview.add(p); newToDelete.add(p); });
      } else {
        group.forEach((p) => {
          removeFromReview.add(p);
          if (p !== decision.keep) newToDelete.add(p);
        });
      }
    });

    const remainingFiles = files.filter((f) => !removeFromReview.has(f));
    setFiles(remainingFiles);
    setToDelete(newToDelete);
    setDuplicates(remainingDuplicates);
    setIndex(0);

    if (remainingFiles.length === 0) {
      setReturnTo('done');
      setPhase('confirm');
    } else {
      setPhase('reviewing');
    }
  }

  async function finishReview() {
    if (folderPath) {
      const renamed = await window.pinder.renameFolderDone(folderPath);
      if (renamed) {
        setFolderPath(renamed);
        addToast(`Folder marked done: ${basename(renamed)}`, 'success');
      } else {
        addToast("Couldn't rename folder", 'warning');
      }
    }
    setPhase('done');
  }

  async function confirmTrash() {
    const count = toDelete.size;
    setTrashLoading(true);
    try {
      await window.pinder.deleteFiles([...toDelete]);
      addToast(`Moved ${count} file${count !== 1 ? 's' : ''} to Trash`, 'success');
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 1100);
      if (returnTo === 'reviewing') {
        setToDelete(new Set());
        setPhase('reviewing');
      } else {
        await finishReview();
      }
    } finally {
      setTrashLoading(false);
    }
  }

  function cancelConfirm() {
    if (returnTo === 'reviewing') {
      setPhase('reviewing');
    } else {
      finishReview();
    }
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
    setFolderPath(null);
    setDuplicates(new Set());
    setDuplicateGroups([]);
    setDupDecisions({});
    setPhase('idle');
  }

  let content = null;

  // ── Idle ──────────────────────────────────────────────
  if (phase === 'idle') {
    content = (
      <div className="screen idle">
        <div className="mesh-bg" aria-hidden="true">
          <span className="mesh-blob mesh-blob-1" />
          <span className="mesh-blob mesh-blob-2" />
          <span className="mesh-blob mesh-blob-3" />
        </div>
        <img src="logo.png" className="app-logo" alt="Pinder logo" />
        <h1 className="logo">Pinder</h1>
        <p className="subtitle">Swipe away the gigabytes.</p>
        <button className="btn-primary" onClick={openFolder} disabled={folderLoading}>
          {folderLoading ? (
            <>
              <span className="spinner" />
              Opening…
            </>
          ) : (
            'Open Folder'
          )}
        </button>
        <p className="hint">← delete &nbsp;&nbsp; → keep &nbsp;&nbsp; Z undo</p>
      </div>
    );
  }

  // ── Ready (folder summary) ────────────────────────────
  if (phase === 'ready' && folderSummary) {
    content = (
      <div className="screen idle">
        <div className="mesh-bg mesh-bg-header" aria-hidden="true">
          <span className="mesh-blob mesh-blob-1" />
          <span className="mesh-blob mesh-blob-2" />
          <span className="mesh-blob mesh-blob-3" />
        </div>
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
          {folderSummary.dupGroupCount > 0 && (
            <div className="summary-row">
              <span className="summary-label">Duplicate groups</span>
              <span className="summary-value summary-dup">
                {folderSummary.dupGroupCount} ({folderSummary.dupFileCount} files)
              </span>
            </div>
          )}
        </div>
        {folderSummary.dupGroupCount > 0 && (
          <button className="btn-secondary" onClick={openDuplicates}>
            Resolve {folderSummary.dupGroupCount} duplicate group{folderSummary.dupGroupCount !== 1 ? 's' : ''} first
          </button>
        )}
        <button className="btn-primary" onClick={startReview} style={{ marginTop: 4 }}>
          Start Review
        </button>
        <button className="btn-secondary" onClick={restart} style={{ marginTop: 4 }}>
          Choose different folder
        </button>
      </div>
    );
  }

  // ── Duplicates ────────────────────────────────────────
  if (phase === 'duplicates') {
    content = (
      <div className="screen confirm">
        <h2>{duplicateGroups.length} duplicate group{duplicateGroups.length !== 1 ? 's' : ''}</h2>
        <p className="hint">Click a copy to keep it and discard the rest, or choose an action below each group.</p>
        <div className="dup-groups">
          {duplicateGroups.map((group, i) => {
            const decision = dupDecisions[i];
            const keepPath = decision && decision !== 'discard-all' ? decision.keep : null;
            return (
              <div key={group[0]} className="dup-group">
                <div className="dup-group-thumbs">
                  {group.map((f) => (
                    <DupThumb
                      key={f}
                      filePath={f}
                      isKeep={keepPath === f}
                      onKeep={() => setDupDecision(i, { keep: f })}
                    />
                  ))}
                </div>
                <div className="dup-group-actions">
                  <button
                    className={`btn-tertiary${!decision || decision === 'keep-all' ? ' active' : ''}`}
                    onClick={() => setDupDecision(i, 'keep-all')}
                  >
                    Keep all copies
                  </button>
                  <button
                    className={`btn-tertiary btn-tertiary-danger${decision === 'discard-all' ? ' active' : ''}`}
                    onClick={() => setDupDecision(i, 'discard-all')}
                  >
                    Discard all
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="confirm-buttons">
          <button className="btn-primary" onClick={resolveDuplicatesAndContinue}>
            Continue to Review
          </button>
          <button className="btn-secondary" onClick={() => setPhase('ready')}>
            Back
          </button>
        </div>
      </div>
    );
  }

  // ── Reviewing ─────────────────────────────────────────
  if (phase === 'reviewing') {
    const current = files[index];
    const video = isVideo(current);
    const pdf = isPdf(current);
    const src = video || pdf ? mediaSrc(current) : thumbSrc(current, PREVIEW_WIDTH);
    const isDuplicate = duplicates.has(current);
    const mediaClass = `media swipe-card${swipeDir ? ` swipe-exit-${swipeDir}` : ''}`;
    const totalBatches = Math.ceil(files.length / BATCH_SIZE);
    const batchStart = Math.floor(index / BATCH_SIZE) * BATCH_SIZE;
    const batchEnd = Math.min(batchStart + BATCH_SIZE, files.length);
    const batchFiles = files.slice(batchStart, batchEnd);

    content = (
      <div className={`screen reviewing ${flash ? `flash-${flash}` : ''}`}>
        <div className="mesh-bg mesh-bg-header" aria-hidden="true">
          <span className="mesh-blob mesh-blob-1" />
          <span className="mesh-blob mesh-blob-2" />
          <span className="mesh-blob mesh-blob-3" />
        </div>
        {toDelete.size > 0 && (
          <button className="review-flagged-btn" onClick={openReviewMid}>
            Review flagged ({toDelete.size})
          </button>
        )}
        <div className="counter">
          {index + 1} / {files.length}
          {totalBatches > 1 && (
            <span className="batch-counter"> · batch {Math.floor(index / BATCH_SIZE) + 1}/{totalBatches}</span>
          )}
        </div>
        {fileInfo ? (
          <div className="file-info">
            <span className="file-info-name">{basename(files[index])}</span>
            {isDuplicate && <span className="dup-badge">Possible duplicate</span>}
            <span>{formatSize(fileInfo.size)}</span>
            <span>{formatDate(fileInfo.created)}</span>
          </div>
        ) : (
          <div className="file-info-skeleton">
            <div className="skeleton-line" />
            <div className="skeleton-line short" />
          </div>
        )}
        {video ? (
          <video key={current} src={src} autoPlay loop muted className={mediaClass} />
        ) : pdf ? (
          <embed key={current} src={src} type="application/pdf" className={`${mediaClass} media-pdf`} />
        ) : (
          <img key={current} src={src} alt={basename(current)} className={mediaClass} />
        )}
        <div className="filmstrip" ref={filmstripRef}>
          {batchFiles.map((f, batchI) => {
            const i = batchStart + batchI;
            return (
              <div
                key={f}
                ref={i === index ? activeThumbRef : null}
                className={`strip-thumb${i === index ? ' active' : ''}${toDelete.has(f) ? ' flagged' : ''}`}
                onClick={() => setIndex(i)}
              >
                {isVideo(f)
                  ? <div className="strip-video-icon">▶</div>
                  : isPdf(f)
                  ? <div className="strip-video-icon"><span role="img" aria-label="PDF document">📄</span></div>
                  : <img src={thumbSrc(f, FILMSTRIP_THUMB_WIDTH)} alt="" loading="lazy" />}
              </div>
            );
          })}
        </div>
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
    content = (
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
                  <video src={mediaSrc(f)} muted />
                ) : isPdf(f) ? (
                  <div className="grid-pdf-icon"><span role="img" aria-label="PDF document">📄</span></div>
                ) : (
                  <img src={thumbSrc(f, GRID_THUMB_WIDTH)} alt={basename(f)} loading="lazy" />
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
            <button className="btn-danger" onClick={confirmTrash} disabled={trashLoading}>
              {trashLoading ? (
                <>
                  <span className="spinner" />
                  Moving…
                </>
              ) : (
                `Move to Trash (${count})`
              )}
            </button>
          )}
          <button className="btn-secondary" onClick={cancelConfirm} disabled={trashLoading}>
            {returnTo === 'reviewing' ? 'Back to review' : count === 0 ? 'Done' : 'Cancel — keep all'}
          </button>
        </div>
      </div>
    );
  }

  // ── Done ──────────────────────────────────────────────
  if (phase === 'done') {
    content = (
      <div className="screen idle">
        <h1 className="logo">All done.</h1>
        <button className="btn-primary" onClick={restart}>
          Start over
        </button>
      </div>
    );
  }

  return (
    <>
      {content}
      <ToastStack toasts={toasts} phase={phase} />
      {showConfetti && <Confetti />}
    </>
  );
}

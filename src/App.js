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

export default function App() {
  const [files, setFiles] = useState([]);
  const [index, setIndex] = useState(0);
  const [toDelete, setToDelete] = useState(new Set());
  const [phase, setPhase] = useState('idle'); // idle | reviewing | confirm | done
  const [flash, setFlash] = useState(null); // 'keep' | 'delete' | null

  const triggerFlash = useCallback((type) => {
    setFlash(type);
    setTimeout(() => setFlash(null), 300);
  }, []);

  const advance = useCallback((currentIndex, total) => {
    if (currentIndex + 1 >= total) {
      setPhase('confirm');
    } else {
      setIndex(currentIndex + 1);
    }
  }, []);

  useEffect(() => {
    if (phase !== 'reviewing') return;

    const handleKey = (e) => {
      if (e.key === 'ArrowRight') {
        triggerFlash('keep');
        advance(index, files.length);
      } else if (e.key === 'ArrowLeft') {
        triggerFlash('delete');
        setToDelete((prev) => new Set([...prev, files[index]]));
        advance(index, files.length);
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [phase, index, files, advance, triggerFlash]);

  async function openFolder() {
    const paths = await window.pinder.openFolder();
    if (!paths.length) return;
    setFiles(paths);
    setIndex(0);
    setToDelete(new Set());
    setPhase('reviewing');
  }

  async function confirmDelete() {
    await window.pinder.deleteFiles([...toDelete]);
    setPhase('done');
  }

  function restart() {
    setFiles([]);
    setIndex(0);
    setToDelete(new Set());
    setPhase('idle');
  }

  if (phase === 'idle') {
    return (
      <div className="screen idle">
        <h1 className="logo">Pinder</h1>
        <p className="subtitle">Swipe through your photos and videos</p>
        <button className="btn-primary" onClick={openFolder}>
          Open Folder
        </button>
        <p className="hint">← delete &nbsp;&nbsp; → keep</p>
      </div>
    );
  }

  if (phase === 'reviewing') {
    const current = files[index];
    const video = isVideo(current);
    const src = `file://${current}`;

    return (
      <div className={`screen reviewing ${flash ? `flash-${flash}` : ''}`}>
        <div className="counter">{index + 1} / {files.length}</div>
        {video ? (
          <video
            key={current}
            src={src}
            autoPlay
            loop
            muted
            className="media"
          />
        ) : (
          <img key={current} src={src} alt={basename(current)} className="media" />
        )}
        <div className="filename">{basename(current)}</div>
        <div className="hint-bar">
          <span className="hint-delete">← delete</span>
          <span className="hint-keep">keep →</span>
        </div>
      </div>
    );
  }

  if (phase === 'confirm') {
    const count = toDelete.size;
    return (
      <div className="screen confirm">
        <h2>{count === 0 ? 'Nothing to delete' : `Delete ${count} file${count !== 1 ? 's' : ''}?`}</h2>
        {count > 0 && (
          <ul className="delete-list">
            {[...toDelete].map((f) => (
              <li key={f}>{basename(f)}</li>
            ))}
          </ul>
        )}
        <div className="confirm-buttons">
          {count > 0 && (
            <button className="btn-danger" onClick={confirmDelete}>
              Delete {count} file{count !== 1 ? 's' : ''}
            </button>
          )}
          <button className="btn-secondary" onClick={restart}>
            {count === 0 ? 'Done' : 'Cancel — keep all'}
          </button>
        </div>
      </div>
    );
  }

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

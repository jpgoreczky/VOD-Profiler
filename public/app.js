/* app.js – VOD Profiler frontend logic
 *
 * Handles:
 *  - Tab switching (File / URL)
 *  - Drag-and-drop + click-to-browse file selection
 *  - Chunked file upload to /api/upload
 *  - URL-based scan request to /api/recognize (via a small proxy path)
 *  - Rendering the results table
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB – stays under Vercel's 4.5 MB limit

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const tabBtns = document.querySelectorAll('.tab-btn');
const tabPanels = document.querySelectorAll('.tab-panel');

const dropArea = document.getElementById('dropArea');
const fileInput = document.getElementById('fileInput');
const selectedFileName = document.getElementById('selectedFileName');
const uploadBtn = document.getElementById('uploadBtn');
const progressWrap = document.getElementById('progressWrap');
const progressBar = document.getElementById('progressBar');
const progressLabel = document.getElementById('progressLabel');
const fileStatus = document.getElementById('fileStatus');

const urlInput = document.getElementById('urlInput');
const urlScanBtn = document.getElementById('urlScanBtn');
const urlStatus = document.getElementById('urlStatus');

const resultsSection = document.getElementById('resultsSection');
const resultCount = document.getElementById('resultCount');
const resultsBody = document.getElementById('resultsBody');
const noResults = document.getElementById('noResults');

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------
tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    tabBtns.forEach((b) => b.classList.remove('active'));
    tabPanels.forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ---------------------------------------------------------------------------
// File selection
// ---------------------------------------------------------------------------
dropArea.addEventListener('click', () => fileInput.click());

dropArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropArea.classList.add('drag-over');
});

dropArea.addEventListener('dragleave', () => dropArea.classList.remove('drag-over'));

dropArea.addEventListener('drop', (e) => {
  e.preventDefault();
  dropArea.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) setFile(file);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) setFile(fileInput.files[0]);
});

let selectedFile = null;

function setFile(file) {
  selectedFile = file;
  selectedFileName.textContent = `Selected: ${file.name} (${formatBytes(file.size)})`;
  uploadBtn.disabled = false;
  setStatus(fileStatus, '', '');
  hideResults();
}

// ---------------------------------------------------------------------------
// Chunked upload
// ---------------------------------------------------------------------------
uploadBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  uploadBtn.disabled = true;
  setStatus(fileStatus, 'Preparing upload…', '');
  showProgress(0, 0);

  const uploadId = generateId();
  const totalChunks = Math.ceil(selectedFile.size / CHUNK_SIZE);

  try {
    let lastResponse = null;

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, selectedFile.size);
      const chunkBlob = selectedFile.slice(start, end);

      const form = new FormData();
      form.append('chunk', chunkBlob, selectedFile.name);
      form.append('uploadId', uploadId);
      form.append('chunkIndex', String(i));
      form.append('totalChunks', String(totalChunks));
      form.append('filename', selectedFile.name);

      // Pass an estimated duration if we can extract it
      const durationSec = await getMediaDuration(selectedFile);
      if (durationSec) form.append('totalDuration', String(durationSec));

      showProgress(i + 1, totalChunks);
      setStatus(fileStatus, `Uploading chunk ${i + 1} of ${totalChunks}…`, '');

      const response = await fetch('/api/upload', {
        method: 'POST',
        body: form,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || `Server error ${response.status}`);
      }

      lastResponse = data;

      if (data.done) {
        renderResults(data.results || []);
        if (data.errors && data.errors.length > 0) {
          setStatus(
            fileStatus,
            `Scan complete with ${data.errors.length} segment error(s). See console for details.`,
            'error'
          );
          console.warn('Segment errors:', data.errors);
        } else {
          setStatus(fileStatus, 'Scan complete!', 'success');
        }
        break;
      }
    }

    // If the server never returned done:true (shouldn't happen, but guard it)
    if (lastResponse && !lastResponse.done) {
      setStatus(fileStatus, 'All chunks sent but no final result received.', 'error');
    }
  } catch (err) {
    setStatus(fileStatus, `Error: ${err.message}`, 'error');
    console.error(err);
  } finally {
    uploadBtn.disabled = false;
    hideProgress();
  }
});

// ---------------------------------------------------------------------------
// URL scan
// ---------------------------------------------------------------------------
urlScanBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  if (!url) {
    setStatus(urlStatus, 'Please enter a URL.', 'error');
    return;
  }

  urlScanBtn.disabled = true;
  setStatus(urlStatus, 'Fetching and scanning audio…', '');
  hideResults();

  try {
    const response = await fetch('/api/recognize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `Server error ${response.status}`);
    }

    renderResults(data.results || []);
    setStatus(urlStatus, 'Scan complete!', 'success');
  } catch (err) {
    setStatus(urlStatus, `Error: ${err.message}`, 'error');
    console.error(err);
  } finally {
    urlScanBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Results rendering
// ---------------------------------------------------------------------------
function renderResults(results) {
  resultsBody.innerHTML = '';
  resultsSection.classList.add('visible');

  const count = results.length;
  resultCount.textContent = `${count} match${count !== 1 ? 'es' : ''}`;

  if (count === 0) {
    noResults.style.display = 'block';
    document.getElementById('resultsTable').style.display = 'none';
    return;
  }

  noResults.style.display = 'none';
  document.getElementById('resultsTable').style.display = '';

  results.forEach((r, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>
        <strong>${escapeHtml(r.trackTitle)}</strong>
        ${r.album && r.album !== 'Unknown Album' ? `<br /><small style="color:var(--text-muted)">${escapeHtml(r.album)}</small>` : ''}
      </td>
      <td>${escapeHtml(r.artist)}</td>
      <td>
        <code style="font-size:0.8rem">${escapeHtml(r.timestampStart)}</code>
        <span style="color:var(--text-muted)"> – </span>
        <code style="font-size:0.8rem">${escapeHtml(r.timestampEnd)}</code>
      </td>
      <td>
        ${r.confidenceScore}%
        <div class="score-bar-bg">
          <div class="score-bar" style="width:${Math.min(100, r.confidenceScore)}%"></div>
        </div>
      </td>
      <td><span class="risk-badge risk-${escapeHtml(r.dmcaRisk)}">${escapeHtml(r.dmcaRisk)}</span></td>
    `;
    resultsBody.appendChild(tr);
  });
}

function hideResults() {
  resultsSection.classList.remove('visible');
  resultsBody.innerHTML = '';
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(str) {
  if (typeof str !== 'string') return String(str);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setStatus(el, msg, type) {
  el.textContent = msg;
  el.className = `status-msg${type ? ' ' + type : ''}`;
}

function showProgress(current, total) {
  progressWrap.classList.add('visible');
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  progressBar.style.width = `${pct}%`;
  progressLabel.textContent = total > 0 ? `Uploading chunk ${current} / ${total}` : 'Preparing…';
}

function hideProgress() {
  progressWrap.classList.remove('visible');
}

/**
 * Attempt to extract the duration of the media file using the browser's
 * HTMLMediaElement API.  Returns null if the browser cannot read duration.
 *
 * @param {File} file
 * @returns {Promise<number|null>}
 */
function getMediaDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const media = document.createElement('video');
    media.preload = 'metadata';
    media.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(isFinite(media.duration) ? media.duration : null);
    };
    media.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    media.src = url;
  });
}

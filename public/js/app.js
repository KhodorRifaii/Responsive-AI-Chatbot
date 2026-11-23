import { uploadDocuments, askQuestion, getHealth, getDocuments } from './api.js';

const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.txt', '.csv'];
const MAX_FILE_SIZE_MB = 10;

const els = {
  fileInput: document.getElementById('fileInput'),
  dropzone: document.getElementById('dropzone'),
  uploadStatus: document.getElementById('uploadStatus'),
  messages: document.getElementById('messages'),
  emptyState: document.getElementById('emptyState'),
  chatForm: document.getElementById('chatForm'),
  questionInput: document.getElementById('questionInput'),
  sendButton: document.getElementById('sendButton'),
  questionError: document.getElementById('questionError'),
  setupAlert: document.getElementById('setupAlert'),
  docsList: document.getElementById('docsList'),
  docsCount: document.getElementById('docsCount'),
  docsEmpty: document.getElementById('docsEmpty'),
  themeToggle: document.getElementById('themeToggle'),
  clearChat: document.getElementById('clearChat'),
  chatArea: document.getElementById('chatArea'),
  dropOverlay: document.getElementById('dropOverlay'),
};

// ---- Theme (light / dark), remembered in localStorage ----

const THEME_KEY = 'docchat-theme';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-bs-theme', theme);
  const next = theme === 'dark' ? 'light' : 'dark';
  const label = `Switch to ${next} mode`;
  els.themeToggle.setAttribute('aria-label', label);
  els.themeToggle.title = label;
  els.themeToggle.innerHTML = `<i class="bi ${theme === 'dark' ? 'bi-sun' : 'bi-moon-stars'}"></i>`;
}

els.themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-bs-theme');
  const theme = current === 'dark' ? 'light' : 'dark';
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage unavailable: the theme still changes for this visit.
  }
});

applyTheme(document.documentElement.getAttribute('data-bs-theme') || 'light');

// ---- Documents list ----

const FILE_ICONS = { pdf: 'bi-file-earmark-pdf', docx: 'bi-file-earmark-word', txt: 'bi-file-earmark-text', csv: 'bi-file-earmark-spreadsheet' };

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderDocuments(documents) {
  els.docsList.replaceChildren(...documents.map((doc) => {
    const extension = doc.name.split('.').pop().toLowerCase();
    const li = document.createElement('li');
    li.className = 'doc-item';
    li.innerHTML = `<i class="bi ${FILE_ICONS[extension] ?? 'bi-file-earmark'}" aria-hidden="true"></i>`;
    const text = document.createElement('div');
    text.className = 'doc-text';
    const name = document.createElement('span');
    name.className = 'doc-name';
    name.textContent = doc.name;
    name.title = doc.name;
    const meta = document.createElement('span');
    meta.className = 'doc-meta';
    meta.textContent = `${formatSize(doc.size)}, ${doc.chunks} ${doc.chunks === 1 ? 'part' : 'parts'}`;
    text.append(name, meta);
    li.append(text);
    return li;
  }));
  els.docsCount.textContent = String(documents.length);
  const hasDocs = documents.length > 0;
  document.getElementById('emptyTitle').textContent = hasDocs ? 'Ask about your documents' : 'Upload a document to get started';
  document.getElementById('emptyText').textContent = hasDocs
    ? 'Type a question below. Answers only use what is in your files.'
    : 'Add a PDF, Word file, text file or spreadsheet, then ask anything about it.';
  els.docsEmpty.hidden = hasDocs;
}

async function refreshDocuments() {
  try {
    const { documents, sessionExpired } = await getDocuments();
    renderDocuments(documents);
    if (sessionExpired && history.length > 0) {
      expireChat('Your documents were removed after a period without activity (or a server restart), so the old chat was cleared. Upload them again to keep asking.');
    }
  } catch {
    // The list is informative only; upload errors are shown elsewhere.
  }
}

function setUploadStatus(message, type = 'info') {
  els.uploadStatus.textContent = message;
  els.uploadStatus.className = `upload-status is-${type}`;
  els.uploadStatus.hidden = !message;
}

/** Check files in the browser first so obvious problems get an instant message. */
function validateFiles(files) {
  const problems = [];
  const valid = files.filter((file) => {
    const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(extension)) {
      problems.push(`"${file.name}" is not supported. Upload a PDF, DOCX, TXT or CSV file.`);
      return false;
    }
    if (file.size === 0) {
      problems.push(`"${file.name}" is empty.`);
      return false;
    }
    if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      problems.push(`"${file.name}" is larger than ${MAX_FILE_SIZE_MB} MB.`);
      return false;
    }
    return true;
  });
  return { valid, problems };
}

/**
 * Progress note in the chat while files are uploaded and indexed (visible on phones too,
 * where the sidebar is hidden). Only the bar and its text change; the sidebar status is
 * updated once per file and stage, so screen readers are not flooded with percentages.
 */
function showUploadProgress(label) {
  els.emptyState.hidden = true;
  const note = document.createElement('div');
  note.className = 'message chat-notice upload-progress';
  note.innerHTML = '<i class="bi bi-hourglass-split" aria-hidden="true"></i>';
  const text = document.createElement('span');
  text.className = 'upload-progress-text';
  text.textContent = label;
  const bar = document.createElement('div');
  bar.className = 'progress';
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', 'Upload progress');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', '0');
  const fill = document.createElement('div');
  fill.className = 'progress-bar';
  fill.style.width = '0%';
  bar.append(fill);
  note.append(text, bar);
  els.messages.append(note);
  scrollToBottom();

  let lastStep = '';
  return {
    update({ file, files, name, stage, done, total }) {
      const which = files > 1 ? ` (file ${file} of ${files})` : '';
      const message = stage === 'embedding' && total
        ? `Indexing ${name}${which}: ${done} of ${total} parts`
        : `Reading ${name}${which}…`;
      text.textContent = message;
      const fileShare = stage === 'embedding' && total ? done / total : 0;
      const percent = Math.round(((file - 1 + fileShare) / files) * 100);
      fill.style.width = `${percent}%`;
      bar.setAttribute('aria-valuenow', String(percent));
      const step = `${file}:${stage}`;
      if (step !== lastStep) {
        lastStep = step;
        setUploadStatus(stage === 'embedding' ? `Indexing ${name}${which}…` : message);
      }
    },
    remove() {
      note.remove();
    },
  };
}

const EXPIRED_UPLOAD_NOTE = 'Your earlier documents were removed after a period without activity (or a server restart), so the old chat was cleared.';

async function handleFiles(fileList) {
  const { valid: files, problems } = validateFiles([...fileList]);
  if (files.length === 0) {
    if (problems.length) {
      setUploadStatus(problems.join(' '), 'error');
      appendMessage('error', problems.join(' '));
    }
    els.fileInput.value = '';
    return;
  }

  const uploading = `Uploading ${files.length === 1 ? files[0].name : `${files.length} files`}…`;
  setUploadStatus(uploading);
  const progress = showUploadProgress(uploading);
  try {
    const { documents, errors = [], sessionExpired } = await uploadDocuments(files, { onProgress: progress.update });
    progress.remove();
    // The earlier documents were gone before this upload: their old answers must not stay on screen.
    if (sessionExpired && history.length > 0) expireChat(EXPIRED_UPLOAD_NOTE);
    const names = documents.map((doc) => doc.name).join(', ');
    const skipped = [...problems, ...errors.map((e) => e.error)];
    if (skipped.length) {
      setUploadStatus(`Ready: ${names}. Skipped: ${skipped.join(' ')}`, 'warning');
    } else {
      setUploadStatus(`Ready: ${names}. Ask a question below.`, 'success');
    }
    // New files are searchable right away, no restart needed; tell the user in the chat too.
    appendNotice(`Added ${names}. You can ask about ${documents.length === 1 ? 'it' : 'them'} now.`);
    // The sidebar is hidden on phones, so skipped files are reported in the chat as well.
    if (skipped.length) appendMessage('error', `Skipped: ${skipped.join(' ')}`);
  } catch (error) {
    progress.remove();
    if (error.sessionExpired && history.length > 0) expireChat(EXPIRED_UPLOAD_NOTE);
    setUploadStatus(error.message, 'error');
    appendMessage('error', error.message);
  } finally {
    els.fileInput.value = '';
    refreshDocuments();
  }
}

els.fileInput.addEventListener('change', () => handleFiles(els.fileInput.files));

// Drag and drop files anywhere on the page, at any time during the chat.
let dragDepth = 0;
function hasFiles(event) {
  return [...(event.dataTransfer?.types ?? [])].includes('Files');
}
function showDropOverlay(show) {
  els.dropOverlay.hidden = !show;
  els.dropzone.classList.toggle('is-dragover', show);
}
document.addEventListener('dragenter', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  showDropOverlay(true);
});
document.addEventListener('dragover', (event) => {
  if (hasFiles(event)) event.preventDefault();
});
document.addEventListener('dragleave', (event) => {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) showDropOverlay(false);
});
document.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  showDropOverlay(false);
  handleFiles(event.dataTransfer.files);
});

// The paperclip label opens the file picker with Enter/Space too.
document.querySelector('.composer-attach').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    els.fileInput.click();
  }
});

// ---- Chat ----

// Conversation for this browser session: [{ role: 'user' | 'assistant', content }]
const HISTORY_KEY = 'docchat-history';
const MAX_HISTORY_SENT = 6;
let history = loadHistory();

function loadHistory() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(HISTORY_KEY));
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function updateClearButton() {
  els.clearChat.disabled = history.length === 0;
}

function saveHistory() {
  updateClearButton();
  try {
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Storage may be unavailable (private mode); history still works in memory.
  }
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

// ---- Minimal, safe Markdown for AI answers (bold, inline code, lists, paragraphs) ----

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderInline(text) {
  // Escape first, so the model's text can never inject HTML.
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function renderMarkdown(text) {
  const html = [];
  let list = null; // 'ul' | 'ol' | null
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) html.push(`<p>${paragraph.join('<br>')}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (list) html.push(`</${list}>`);
    list = null;
  };

  for (const line of text.split('\n')) {
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const type = bullet ? 'ul' : 'ol';
      if (list !== type) {
        closeList();
        html.push(`<${type}>`);
        list = type;
      }
      html.push(`<li>${renderInline((bullet || numbered)[1])}</li>`);
    } else if (!line.trim()) {
      flushParagraph();
      closeList();
    } else {
      closeList();
      if (heading) {
        flushParagraph();
        html.push(`<p><strong>${renderInline(heading[1])}</strong></p>`);
      } else {
        paragraph.push(renderInline(line.trim()));
      }
    }
  }
  flushParagraph();
  closeList();
  return html.join('');
}

/** Collapsible list of the document excerpts an answer was based on. */
function renderSources(sources) {
  const details = document.createElement('details');
  details.className = 'sources';

  const summary = document.createElement('summary');
  summary.textContent = sources.length === 1 ? 'Source: 1 excerpt' : `Sources: ${sources.length} excerpts`;
  details.append(summary);

  const list = document.createElement('ol');
  list.className = 'sources-list';
  for (const item of sources) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'source-name';
    name.innerHTML = '<i class="bi bi-file-earmark-text" aria-hidden="true"></i> ';
    name.append(item.page ? `${item.source}, page ${item.page}` : item.source);
    const where = document.createElement('span');
    where.className = 'source-chunk';
    where.textContent = `part ${item.chunk}`;
    const excerpt = document.createElement('mark');
    excerpt.className = 'source-excerpt';
    excerpt.textContent = item.excerpt;
    li.append(name, where, excerpt);
    list.append(li);
  }
  details.append(list);
  return details;
}

/** Render one chat message. role: "user" | "assistant" | "error". */
function appendMessage(role, text, sources = []) {
  els.emptyState.hidden = true;

  const row = document.createElement('div');
  row.className = `message message-${role}`;

  const avatar = document.createElement('span');
  avatar.className = 'message-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  const icons = { user: 'bi-person', assistant: 'bi-journal-text', error: 'bi-exclamation-triangle' };
  avatar.innerHTML = `<i class="bi ${icons[role]}"></i>`;

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';

  const label = document.createElement('span');
  label.className = 'visually-hidden';
  const labels = { user: 'You said: ', assistant: 'DocChat answered: ', error: 'Error: ' };
  label.textContent = labels[role];

  const body = document.createElement('div');
  body.className = 'message-text';
  if (role === 'assistant') {
    body.classList.add('is-formatted');
    body.innerHTML = renderMarkdown(text);
  } else {
    body.textContent = text;
  }

  bubble.append(label, body);
  if (role === 'assistant' && sources.length) bubble.append(renderSources(sources));
  row.append(avatar, bubble);
  els.messages.append(row);
  scrollToBottom();
  return row;
}

/** Show a "thinking" bubble and lock the composer while the answer is generated. */
function setLoading(isLoading) {
  els.sendButton.disabled = isLoading;
  els.questionInput.readOnly = isLoading;
  els.messages.setAttribute('aria-busy', String(isLoading));
  els.sendButton.innerHTML = isLoading
    ? '<span class="spinner-border spinner-border-sm" aria-hidden="true"></span>'
    : '<i class="bi bi-send-fill"></i>';

  document.getElementById('typingIndicator')?.remove();
  if (isLoading) {
    const row = document.createElement('div');
    row.className = 'message message-assistant';
    row.id = 'typingIndicator';
    row.innerHTML = `
      <span class="message-avatar" aria-hidden="true"><i class="bi bi-journal-text"></i></span>
      <div class="message-bubble typing" role="status">
        <span class="typing-dots" aria-hidden="true"><span></span><span></span><span></span></span>
        <span class="typing-label">Reading your documents…</span>
      </div>`;
    els.messages.append(row);
    scrollToBottom();
  }
}

/** Small centered note in the chat (not part of the conversation history). */
function appendNotice(text, icon = 'bi-file-earmark-check') {
  els.emptyState.hidden = true;
  const note = document.createElement('p');
  note.className = 'message chat-notice';
  note.setAttribute('role', 'status');
  note.innerHTML = `<i class="bi ${icon}" aria-hidden="true"></i> `;
  note.append(text);
  els.messages.append(note);
  scrollToBottom();
}

async function sendQuestion(question) {
  const recentHistory = history.slice(-MAX_HISTORY_SENT).map(({ role, content }) => ({ role, content }));
  appendMessage('user', question);
  history.push({ role: 'user', content: question });
  saveHistory();

  setLoading(true);
  try {
    const { answer, sources = [] } = await askQuestion(question, recentHistory);
    setLoading(false);
    appendMessage('assistant', answer, sources);
    history.push({ role: 'assistant', content: answer, sources });
    saveHistory();
  } catch (error) {
    setLoading(false);
    // Failed turns are not kept in history; the question goes back in the box to retry.
    history.pop();
    saveHistory();
    if (error.code === 'SESSION_EXPIRED') expireChat(error.message);
    else appendMessage('error', error.message);
    if (!els.questionInput.value) {
      els.questionInput.value = question;
      autoGrow();
    }
    if (error.code === 'MISSING_API_KEY') els.setupAlert.hidden = false;
    if (error.code === 'NO_DOCUMENTS' || error.code === 'SESSION_EXPIRED') refreshDocuments();
  } finally {
    setLoading(false);
  }
}

function renderHistory() {
  for (const message of history) appendMessage(message.role, message.content, message.sources);
  updateClearButton();
}

function clearChat() {
  if (els.sendButton.disabled) return; // wait for the current answer
  if (!window.confirm('Clear the whole conversation? Your uploaded documents stay.')) return;
  history = [];
  saveHistory();
  els.messages.querySelectorAll('.message').forEach((node) => node.remove());
  els.emptyState.hidden = false;
  els.questionInput.focus();
}

els.clearChat.addEventListener('click', clearChat);

/**
 * The server deleted this visitor's documents (30 idle minutes or a restart). The old answers
 * and their sources no longer match anything, so clear them and explain why.
 */
function expireChat(message) {
  history = [];
  saveHistory();
  els.messages.querySelectorAll('.message').forEach((node) => node.remove());
  setUploadStatus('');
  appendNotice(message, 'bi-clock-history');
}

// Coming back to a tab after a long break: check whether the documents are still there.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshDocuments();
});

function autoGrow() {
  els.questionInput.style.height = 'auto';
  els.questionInput.style.height = `${els.questionInput.scrollHeight}px`;
}

function showQuestionError(message) {
  els.questionError.textContent = message;
  els.questionError.hidden = !message;
  els.questionInput.classList.toggle('is-invalid', Boolean(message));
}

els.chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (els.sendButton.disabled) return;
  const question = els.questionInput.value.trim();
  if (!question) {
    showQuestionError('Type a question first.');
    els.questionInput.focus();
    return;
  }
  showQuestionError('');
  els.questionInput.value = '';
  autoGrow();
  await sendQuestion(question);
});

// Enter sends, Shift+Enter adds a new line.
els.questionInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    els.chatForm.requestSubmit();
  }
});
els.questionInput.addEventListener('input', () => {
  autoGrow();
  if (els.questionInput.value.trim()) showQuestionError('');
});

renderHistory();
refreshDocuments();

// Warn early when the server has no Gemini key.
getHealth()
  .then(({ llmConfigured }) => { els.setupAlert.hidden = llmConfigured; })
  .catch(() => {});

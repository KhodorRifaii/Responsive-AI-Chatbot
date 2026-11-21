import { uploadDocuments, askQuestion, getHealth } from './api.js';

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
};

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

async function handleFiles(fileList) {
  const { valid: files, problems } = validateFiles([...fileList]);
  if (files.length === 0) {
    if (problems.length) setUploadStatus(problems.join(' '), 'error');
    els.fileInput.value = '';
    return;
  }

  setUploadStatus(`Reading ${files.length === 1 ? files[0].name : `${files.length} files`}…`);
  try {
    const { documents, errors = [] } = await uploadDocuments(files);
    const names = documents.map((doc) => doc.name).join(', ');
    const skipped = [...problems, ...errors.map((e) => e.error)];
    if (skipped.length) {
      setUploadStatus(`Ready: ${names}. Skipped: ${skipped.join(' ')}`, 'warning');
    } else {
      setUploadStatus(`Ready: ${names}. Ask a question below.`, 'success');
    }
  } catch (error) {
    setUploadStatus(error.message, 'error');
  } finally {
    els.fileInput.value = '';
  }
}

els.fileInput.addEventListener('change', () => handleFiles(els.fileInput.files));

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

function saveHistory() {
  try {
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Storage may be unavailable (private mode); history still works in memory.
  }
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
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
  body.textContent = text;

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
    appendMessage('error', error.message);
    if (!els.questionInput.value) {
      els.questionInput.value = question;
      autoGrow();
    }
    if (error.code === 'MISSING_API_KEY') els.setupAlert.hidden = false;
  } finally {
    setLoading(false);
  }
}

function renderHistory() {
  for (const message of history) appendMessage(message.role, message.content, message.sources);
}

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

// Warn early when the server has no Gemini key.
getHealth()
  .then(({ llmConfigured }) => { els.setupAlert.hidden = llmConfigured; })
  .catch(() => {});

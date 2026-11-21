import { uploadDocuments, askQuestion } from './api.js';

const els = {
  fileInput: document.getElementById('fileInput'),
  dropzone: document.getElementById('dropzone'),
  uploadStatus: document.getElementById('uploadStatus'),
  messages: document.getElementById('messages'),
  emptyState: document.getElementById('emptyState'),
  chatForm: document.getElementById('chatForm'),
  questionInput: document.getElementById('questionInput'),
  sendButton: document.getElementById('sendButton'),
};

function setUploadStatus(message, type = 'info') {
  els.uploadStatus.textContent = message;
  els.uploadStatus.className = `upload-status is-${type}`;
  els.uploadStatus.hidden = !message;
}

async function handleFiles(fileList) {
  const files = [...fileList];
  if (files.length === 0) return;

  setUploadStatus(`Reading ${files.length === 1 ? files[0].name : `${files.length} files`}…`);
  try {
    const { documents } = await uploadDocuments(files);
    const names = documents.map((doc) => doc.name).join(', ');
    setUploadStatus(`Ready: ${names}. Ask a question below.`, 'success');
  } catch (error) {
    setUploadStatus(error.message, 'error');
  } finally {
    els.fileInput.value = '';
  }
}

els.fileInput.addEventListener('change', () => handleFiles(els.fileInput.files));

// ---- Chat ----

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

/** Render one chat message. role: "user" | "assistant". */
function appendMessage(role, text) {
  els.emptyState.hidden = true;

  const row = document.createElement('div');
  row.className = `message message-${role}`;

  const avatar = document.createElement('span');
  avatar.className = 'message-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.innerHTML = role === 'user' ? '<i class="bi bi-person"></i>' : '<i class="bi bi-journal-text"></i>';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';

  const label = document.createElement('span');
  label.className = 'visually-hidden';
  label.textContent = role === 'user' ? 'You said: ' : 'DocChat answered: ';

  const body = document.createElement('div');
  body.className = 'message-text';
  body.textContent = text;

  bubble.append(label, body);
  row.append(avatar, bubble);
  els.messages.append(row);
  scrollToBottom();
  return row;
}

async function sendQuestion(question) {
  appendMessage('user', question);
  const { answer } = await askQuestion(question);
  appendMessage('assistant', answer);
}

function autoGrow() {
  els.questionInput.style.height = 'auto';
  els.questionInput.style.height = `${els.questionInput.scrollHeight}px`;
}

els.chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const question = els.questionInput.value.trim();
  if (!question) return;
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
els.questionInput.addEventListener('input', autoGrow);

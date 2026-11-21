import { uploadDocuments } from './api.js';

const els = {
  fileInput: document.getElementById('fileInput'),
  dropzone: document.getElementById('dropzone'),
  uploadStatus: document.getElementById('uploadStatus'),
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

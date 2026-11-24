# Responsive AI Document Chatbot

A chatbot that answers questions about your own documents. Upload PDF, Word, text or CSV files, then ask anything about them. Answers come only from the uploaded content using Retrieval-Augmented Generation (RAG). If the answer is not in your documents, the chatbot says so instead of guessing.

Every tool and service it uses is free.

## Features

The chatbot covers the following:

- Responsive Bootstrap 5 interface that works on phones, tablets and desktops
- Upload PDF, DOCX, TXT and CSV files (up to 10 MB each, 10 per upload)
- Chat with clear user and AI messages
- Conversation history for the browser session; recent messages are sent with each question so follow-up questions work
- Answers stream in word by word as Gemini writes them, with a loading indicator until the first words arrive
- Upload progress: which file is being read and how many of its parts are indexed, shown in the chat and the sidebar
- Clear error messages for unsupported, empty or damaged files, empty questions, a missing API key and AI service errors
- The document sources (file name, page for PDFs and an excerpt) behind each answer
- Several documents at once, with a list of everything uploaded
- Private documents: each visitor only sees and searches their own files
- Per-visitor rate limits, so one visitor can't use up the shared free Gemini quota
- Automatic fallback to a second Gemini model when the main one is out of quota, busy, too slow or retired
- Dark and light mode, remembered in your browser
- Security headers: a strict Content Security Policy (only this site, no inline scripts), `nosniff`, no framing, no referrer, HSTS over HTTPS
- Clear chat history button
- Add new documents at any time (sidebar, paperclip or drag and drop) without restarting the server

## Tech stack

Everything below is free and open source, except the Gemini API, which has a free tier:

| Part | Choice |
| --- | --- |
| Backend | Node.js, Express 5 |
| RAG framework | LangChain.js |
| Language model | Google Gemini (free tier) via `@langchain/google-genai` |
| Embeddings | `Xenova/all-MiniLM-L6-v2` running locally with Transformers.js (free, no key) |
| Vector store | LangChain `MemoryVectorStore` (in memory) |
| Text splitting | `RecursiveCharacterTextSplitter` (1000 characters, 150 overlap) |
| File parsing | `pdf-parse` (PDF), `mammoth` (DOCX), `papaparse` (CSV) |
| Uploads | `multer` (in memory, size limit and file type whitelist) |
| Rate limits | `express-rate-limit` (in memory, per visitor IP, IPv6 grouped by /64) |
| Frontend | HTML, Bootstrap 5, Bootstrap Icons, vanilla JavaScript (all self-hosted, no CDN) |

## How it works

RAG works in five steps:

1. **Upload:** the server extracts the text from each file and splits it into overlapping chunks.
2. **Embed:** a small embedding model running on your machine turns each chunk into a vector.
3. **Store:** the vectors go into an in-memory vector store, so new files are searchable right away.
4. **Ask:** the server embeds your question (plus the previous question, for follow-ups) and retrieves the 4 most similar chunks.
5. **Answer:** Gemini receives only those chunks, the recent conversation and a strict prompt: use only the context, and reply "I couldn't find that in your uploaded documents." when the answer is not there. The answer streams to the page as it is written.

## Project structure

The backend lives in `src/` and the static frontend in `public/`:

```text
.
├── public/                  # Frontend (served statically)
│   ├── index.html           # Chat page (Bootstrap 5)
│   ├── css/styles.css       # Theme tokens, layout, light and dark mode
│   ├── vendor/              # Self-hosted Bootstrap, Bootstrap Icons and fonts, with their licenses
│   └── js/
│       ├── api.js           # Calls to the backend API
│       ├── theme-init.js    # Applies the saved theme before the page paints
│       └── app.js           # Chat, uploads, history, theme, errors
├── src/
│   ├── server.js            # Starts the HTTP server
│   ├── app.js               # Express app, routes and error handler
│   ├── config.js            # Settings from .env
│   ├── middleware/
│   │   ├── rateLimit.js     # Per-visitor request limits (in memory)
│   │   ├── securityHeaders.js  # CSP, nosniff, frame and referrer headers
│   │   ├── session.js       # Per-visitor session cookie
│   │   └── upload.js        # multer: size limit and file type whitelist
│   ├── routes/
│   │   ├── documents.js     # GET and POST /api/documents
│   │   └── chat.js          # POST /api/chat
│   ├── services/
│   │   ├── documentLoader.js  # Parse PDF, DOCX, TXT, CSV and split into chunks
│   │   ├── embeddings.js      # Local Transformers.js embeddings for LangChain
│   │   ├── vectorStore.js     # One MemoryVectorStore per session, limits and expiry
│   │   └── ragChain.js        # Prompt, retrieval, Gemini call (fallback, streaming) and sources
│   └── utils/
│       ├── httpError.js     # Errors with a status code and a user message
│       └── ndjson.js        # Streamed (newline-delimited JSON) responses: upload progress, answers
├── test/                    # Automated tests (node:test) and small sample files
├── .env.example
├── package.json
└── README.md
```

## Setup

### Requirements

You need:

- Node.js 22 or newer (`npm test` uses test file patterns that need it)
- A free Google Gemini API key
- An internet connection the first time you upload a file (the embedding model, about 100 MB, downloads once into `.cache/`)

### 1. Get a free Gemini API key

1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey) and sign in with a Google account.
2. Click **Create API key** and copy it.

The free tier has daily and per-minute limits that are enough for personal use. No credit card is needed.

### 2. Install

```bash
git clone https://github.com/KhodorRifaii/Responsive-AI-Chatbot.git
cd Responsive-AI-Chatbot
npm install
```

### 3. Configure

```bash
cp .env.example .env
```

Open `.env` and paste your key:

```env
GOOGLE_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-3.5-flash
```

| Variable | Default | Description |
| --- | --- | --- |
| `GOOGLE_API_KEY` | (none) | Your Gemini API key. Required for answers. |
| `GEMINI_MODEL` | `gemini-3.5-flash` | Any Gemini model your key can use on the free tier. |
| `GEMINI_FALLBACK_MODEL` | `gemini-3.5-flash-lite` | Second model, tried automatically when the main model is out of quota, overloaded, too slow or retired. It uses the same API key. `none` turns the fallback off. |
| `GEMINI_TIMEOUT_SECONDS` | `30` | Seconds each model gets to answer (its own retries included) before the fallback is tried. |
| `GEMINI_THINKING_BUDGET` | `0` | Gemini "thinking" tokens per answer. `0` turns thinking off, which saves most of the free quota; `default` uses the model's own setting. |
| `EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | Local embedding model from the Hugging Face Hub. |
| `PORT` | `3000` | Server port. |
| `MAX_FILE_SIZE_MB` | `10` | Maximum size of each uploaded file. |
| `SESSION_TTL_MINUTES` | `30` | Minutes without activity before a visitor's documents are deleted. |
| `MAX_SESSIONS` | `100` | Maximum number of visitors with documents at the same time. |
| `MAX_CHUNKS_PER_SESSION` | `1500` | Maximum text parts per visitor (roughly 1.5 MB of text). |
| `MAX_TOTAL_CHUNKS` | `5000` | Maximum text parts for all visitors together, to stay within 512 MB of memory. |
| `RATE_LIMIT_CHAT_PER_MINUTE` | `10` | Questions per visitor (IP address) per minute. `0` turns the limit off. |
| `RATE_LIMIT_CHAT_PER_HOUR` | `100` | Questions per visitor per hour. |
| `RATE_LIMIT_UPLOADS_PER_HOUR` | `30` | Upload requests per visitor per hour (each can hold up to 10 files). |
| `TRUST_PROXY` | `1` | Number of proxies in front of the app, so rate limits see each visitor's real IP. `1` fits Render. Use `false` when you run the app with nothing in front of it (for example `npm start` on a public server), so visitors can't fake their IP with an `X-Forwarded-For` header. |

If the main model is out of quota, overloaded, too slow or retired, the server asks `GEMINI_FALLBACK_MODEL` instead and logs `LLM fallback: …`. Bad requests and a rejected key are not retried on the fallback, because they would fail there too. If both models fail, the error names the main model. If Google retires the model for good, set `GEMINI_MODEL` to another one, for example `gemini-flash-latest`, and restart the server.

### 4. Start

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000). For development, `npm run dev` restarts the server when you change a file.

### 5. Run the tests

```bash
npm test
```

The tests use Node's built-in test runner, so there is nothing extra to install. They cover the file loaders, private sessions, the memory limits, the rate limits, the model fallback, the security headers, the upload progress stream, answer streaming (including a dropped Gemini stream and a visitor who leaves), the SOURCES line (also hidden while streaming), the settings and the main API routes. They never call Gemini, but the first run needs the embedding model (downloaded once, like the first upload).

## Deployment

The live demo runs on Render (free plan, 512 MB of memory), behind one proxy. That matches the default `TRUST_PROXY=1`. Add `GOOGLE_API_KEY` as an environment variable in Render, never in the code.

The `Dockerfile` was written for Hugging Face Spaces and is not the live target. It still works for running the app in Docker; set `TRUST_PROXY` to match whatever sits in front of the container.

## Use the chatbot

Follow these steps once the server is running:

1. Add one or more documents with the upload area in the sidebar, the paperclip next to the question box, or by dropping files on the page. On a phone, open the sidebar with the button at the top left.
2. Wait for the "Added …" note in the chat.
3. Type a question and press Enter (Shift+Enter adds a new line).
4. Open **Sources** under an answer to see which file, page and excerpt it came from.
5. Ask follow-up questions; the chatbot remembers the conversation until you close the tab.
6. Use the trash button to clear the conversation, and the moon or sun button to switch between dark and light mode.

Uploaded documents stay in memory only and are private to your browser. The server never saves them to disk. Closing the browser ends your access to them, and the server deletes them after 30 minutes without activity or when it restarts. When that happens, the page clears the old conversation and shows a note asking you to upload your files again. Each visitor can keep up to 10 documents.

## API

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/api/health` | | `{ status, llmConfigured, model, fallbackModel }` |
| `GET` | `/api/documents` | | `{ documents: [{ id, name, size, chunks, uploadedAt }], sessionExpired }` |
| `POST` | `/api/documents` | `multipart/form-data`, field `files` | `{ documents, errors, sessionExpired }`, or a progress stream (below) |
| `POST` | `/api/chat` | `{ question, history: [{ role, content }] }` | `{ answer, sources: [{ source, page, chunk, excerpt }] }`, or an answer stream (below) |

**Upload progress.** Send `Accept: application/x-ndjson` with the upload to get one JSON event per line while the server works: `{ "type": "progress", file, files, name, stage, done, total }` (`stage` is `reading`, then `embedding` with `done` of `total` parts), then one final `{ "type": "result", status, ... }` with the same body and status code as the plain JSON answer. Errors that happen before any file is processed (rate limit, size or type limits, no files, server busy) are plain JSON with their HTTP status in both modes. Without the header the answer is plain JSON as before.

**Streamed answers.** Send `Accept: application/x-ndjson` with a question to get `{ "type": "token", text }` events while Gemini writes, then one final `{ "type": "done", answer, sources }` with the same values as the plain JSON answer (the page replaces the streamed text with it). The `SOURCES:` line the model ends with is never streamed. The stream starts with the first words, so errors before that (empty question, no documents, expired session, missing key, both models failing) are plain JSON errors with their HTTP status. The fallback model is only tried before the first words; an error after that ends the stream with `{ "type": "error", status, code, error }`. Without the header the answer is plain JSON as before.

The server identifies each visitor with an httpOnly session cookie (`docchat_sid`), so every call only sees that visitor's documents. When the cookie points to a session the server no longer has (30 idle minutes or a restart), `sessionExpired` is `true` once (on the document list or an upload), chat answers `410 SESSION_EXPIRED`, and the old cookie is removed.

Errors return `{ error, code }` with a matching HTTP status, for example `UNSUPPORTED_FILE`, `EMPTY_FILE`, `EMPTY_QUESTION`, `NO_DOCUMENTS`, `DOCUMENT_TOO_LARGE`, `TOO_MANY_DOCUMENTS`, `SERVER_BUSY`, `SESSION_EXPIRED`, `RATE_LIMITED` (with a `Retry-After` header), `LLM_RATE_LIMIT`, `LLM_BUSY`, `LLM_TIMEOUT` or `MISSING_API_KEY`.

## Third-party files

Bootstrap 5.3.3 (MIT), Bootstrap Icons 1.11.3 (MIT) and the Bricolage Grotesque and Source Sans 3 fonts (SIL Open Font License 1.1) are served from `public/vendor/` instead of a CDN. The page makes no third-party requests and keeps working when a CDN is slow or blocked. Each library's license file sits next to it; `public/vendor/README.md` lists the sources and SHA-256 checksums.

Because everything is self-hosted, the Content Security Policy (`src/middleware/securityHeaders.js`) allows only this site. If you add an external script, style, font or API, add its origin to the matching directive there, or the browser will block it.

## Known limitations

Keep these in mind:

- Scanned PDFs (images without a text layer) have no text to read, so the app rejects them.
- The vector store lives in memory, so a restart clears your documents. Swap `MemoryVectorStore` for a persistent store to keep them.
- Very long files (more than about 1.5 MB of text) are rejected so the server stays within its memory limit.
- English documents and questions work best, because the local embedding model is trained on English.

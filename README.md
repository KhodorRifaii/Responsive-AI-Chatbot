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
├── eval/                    # Quality eval: documents, questions, scorer and runner (see Evaluation)
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
GEMINI_MODEL=gemini-3.5-flash-lite
```

| Variable | Default | Description |
| --- | --- | --- |
| `GOOGLE_API_KEY` | (none) | Your Gemini API key. Required for answers. |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Any Gemini model your key can use on the free tier. This default answered quickly on a free key on 2026-11-24, while `gemini-3.6-flash` returned 429 (quota) and `gemini-3.8-flash` 503 (busy). Free-tier quotas change, so check yours; a stronger model such as `gemini-3.6-flash` is one setting away. |
| `GEMINI_FALLBACK_MODEL` | `gemini-3.1-flash-lite` | Second model, tried automatically when the main model is out of quota, overloaded, too slow or retired. It uses the same API key. `none` turns the fallback off. |
| `GEMINI_TIMEOUT_SECONDS` | `30` | Seconds each model gets to answer (its own retries included) before the fallback is tried. |
| `GEMINI_THINKING_LEVEL` | `minimal` | How much Gemini 3 models think before answering: `minimal`, `low`, `medium` or `high`. Less thinking saves free quota. `default` uses the model's own setting. `gemini-3.8-flash` has no `minimal` and gets `low` instead. |
| `GEMINI_THINKING_BUDGET` | `0` | Thinking tokens per answer for Gemini 2.5 models only. `0` turns thinking off; `default` uses the model's own setting. |
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

Gemini models take different thinking settings. Gemini 3 models use a level (`thinkingLevel`) and reject a token budget; Gemini 2.5 models use the budget. The app builds the setting for each model (`src/services/thinking.js`) from a list of models whose accepted levels were checked against [Google's thinking page](https://aistudio.google.com/docs/thinking) and the live model list. For any model that is not on that list (for example `gemini-3.5-flash`, `gemini-3.7-flash` or a `gemini-4-*` model) it sends no thinking setting, so the model uses its own default. This matters because a wrong setting is a `400` error ("Request contains an invalid argument."): with the old defaults the fallback model rejected every call.

If the main model is out of quota, overloaded, too slow or retired, the server asks `GEMINI_FALLBACK_MODEL` instead and logs `LLM fallback: …`. A rejected key is not retried on the fallback, because it would fail there too. A `400` (the API rejected the request settings, usually the model name or a thinking setting) is not retried either, and it is never hidden: the answer is an `LLM_CONFIG` error that names the model and the setting to check (`GEMINI_MODEL` or `GEMINI_FALLBACK_MODEL`), even when the other model failed first, and the log says `config error`. If both models fail for other reasons, the error names the main model. If Google retires the model for good, set `GEMINI_MODEL` to another one, for example `gemini-flash-latest`, and restart the server.

### 4. Start

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000). For development, `npm run dev` restarts the server when you change a file.

### 5. Run the tests

```bash
npm test
```

The tests use Node's built-in test runner, so there is nothing extra to install. They cover the eval scorer and the file loaders, private sessions, the memory limits, the rate limits, the model fallback, the security headers, the upload progress stream, answer streaming (including a dropped Gemini stream and a visitor who leaves), the SOURCES line (also hidden while streaming), the settings and the main API routes. They never call Gemini, but the first run needs the embedding model (downloaded once, like the first upload).

## Evaluation

`npm run eval` measures answer quality with numbers. It loads 8 fixed documents through the app's real pipeline (loader, splitter, local embeddings, vector store), asks 33 questions with the real prompt and Gemini models, and checks retrieval, answers and refusals. It calls `answerQuestion` (the plain JSON path) directly, not `streamAnswer` and not the HTTP routes, so streaming and the rate limits are not part of it.

- **Documents** (`eval/docs/`): 5 documents that hold the facts (English HR policy, router manual, library branch table as CSV, Arabic clinic guide, Arabic solar FAQ) and 3 look-alike distractors (a second router with different numbers, a second Arabic clinic, a fleet safety handbook). The companies are invented, so the model cannot know the facts. Together they make 18 chunks.
- **Questions** (`eval/questions.jsonl`): 33 lines, each with the expected source file(s) and the key facts (phrases with their unit, such as `24 working days`, with accepted spellings). 20 English and 13 Arabic; 19 single-source, 2 cross-lingual (English question on an Arabic document and the reverse), 4 that need two documents, and 8 that the documents cannot answer. Five of those eight are near-misses (`none-04` to `none-08`): the R5 guide says solid green but the R7 manual has no green light, there is no Orbit R9, there is no study leave, the battery warranty is not stated, and the dental fee is not in the clinic's guide. The first 28 questions were run against Gemini; the five near-misses were added afterwards and have not been run yet.
- **Scoring is deterministic, with no LLM judge.** A fact counts when its words appear as whole tokens in the answer (so `18` never matches `180`) and are not negated ("not 24 working days" does not count). The negation check is a heuristic, not language understanding. A negator counts only in the same clause as the fact (a clause ends at `.`, `,`, `:`, `;`, `?`, `!` or a bracket followed by a space), so "There is no limit: 24 working days" still passes. In English it counts as one of the two words before the fact ("not 24 days", "does not get 24 days") or as "not more/less than". In Arabic it counts up to four words before the fact, because Arabic negates the predicate that follows ("لا يجب الإلغاء قبل 24 ساعة" fails). It can still pass a negation phrased another way, or fail a correct answer that happens to put a negator right before the fact, which is why failures are read by hand. Before comparing, the text is normalized: digits, thousands separators (`45,000`, `45 000`, `45.000`), times (`9:00 p.m.` = `9 pm`, `21:00` = `21`), `$40`, number words (`twelve` = `12`), Arabic spellings and hour words (`الساعة التاسعة صباحا` and `التاسعة صباحا` both mean `9 صباحا`), curly quotes and markdown (`eval/score.js`, tested in `test/evalScore.test.js`). Gold facts are checked when the eval starts (`eval/validate.js`): each must appear in the text of its source files, and none may already be in the question text (an answer that only repeats the question would score it). The runner also warns when a gold phrase appears in a document that is not an expected source. A few of these shared phrases cannot be avoided; they are listed in the question's `shared` field as `{ phrase: reason }`, and the check fails if an entry has no reason or no longer collides. A refusal counts only when the whole answer is the app's "I couldn't find that..." sentence and no sources are shown. Retrieval is deterministic (same documents, same embedder, same numbers every run); the answers are one sample from the model.

### Results

**Mixed models: `gemini-3.5-flash-lite` wrote 26 answers and `gemini-3.6-flash` wrote 2, so this table is not a single-model score. It will be re-run with one model after the model settings are fixed (KHO-24).** Run on 2026-11-24 with `GEMINI_MODEL=gemini-3.6-flash`, `GEMINI_FALLBACK_MODEL=gemini-3.5-flash-lite`, `GEMINI_THINKING_BUDGET=default`, embeddings `Xenova/all-MiniLM-L6-v2`, top-4 chunks. Two questions that hit a rate limit were asked again afterwards with the same settings (`eval/baseline.json` lists them under `meta.retries`). The full run is in `eval/baseline.json`.

| Measure (95% interval in brackets) | All | English | Arabic |
| --- | --- | --- | --- |
| Answerable questions | 25 | 15 | 10 |
| Retrieval: every expected file in the top 4 chunks (random picking: 43%) | 23/25 (92%) [75-98] | 13/15 (87%) [62-96] | 10/10 (100%) [72-100] |
| Retrieval: first chunk is from an expected file (random picking: 16%) | 13/25 (52%) [33-70] | 13/15 (87%) [62-96] | 0/10 (0%) [0-28] |
| Answer correct (every key fact present) | 22/25 (88%) [70-96] | 12/15 (80%) [55-93] | 10/10 (100%) [72-100] |
| Answer correct and every expected source shown (stricter) | 22/25 (88%) [70-96] | 12/15 (80%) [55-93] | 10/10 (100%) [72-100] |
| Unanswerable questions refused correctly (the first 3 only) | 3/3 [44-100] | 2/2 | 1/1 |

By question type, answers were correct for 18/19 single-source, 1/2 cross-lingual and 3/4 two-document questions. Two answerable questions were wrongly refused. Answer time per question: median 2.0s, mean 5.4s, longest 34s.

### What the numbers mean

- **It is a small set.** With 25 answerable questions, one question is about 4 points, and the intervals above are wide (an 88% score could be anywhere from 70% to 96%). Retrieval is the same on every run; the answers are one sample, and Gemini answers can vary between runs. Treat the table as a baseline to compare against, not as a precise score.
- **The scores were recomputed offline.** The table uses the final scorer (phrase facts, negation check, normalization) on the answers stored in `eval/baseline.json`; the old scorer gave the same 22/25. `answeredBy` in the baseline was derived afterwards from the recorded fallback flag, and failure reasons (`logs`) exist only for the two re-asked questions.
- **Which model answered.** The main model, `gemini-3.6-flash`, answered 2 of the 28 questions. For the other 26 it failed first and the fallback `gemini-3.5-flash-lite` answered. The runner recorded the reason only for two of them (a 429 rate-limit error); the first two questions each waited the full 30-second timeout. So these are mostly `gemini-3.5-flash-lite` numbers.
- **These settings were passed on the command line.** With the values in `.env.example` the run could not finish: `gemini-3.5-flash` answered "high demand" (503) after about 35 seconds, and `gemini-3.5-flash-lite` rejected `GEMINI_THINKING_BUDGET=0` with a 400 error (the Gemini 3 models are documented with `thinking_level`, not a token budget). The shell override does not change `.env` or any code.
- **Arabic retrieval does not work yet; the Arabic answers only look good.** The embedding model is trained on English. For 11 of 11 Arabic questions the same chunk (`shifa-center-guide-ar.txt`, part 2) came first, and the right chunk was never first. The answers were still correct because this set has only 6 Arabic chunks, so the top 4 almost always contains the right one. With more Arabic documents this will fail. An English question about an Arabic document was refused (retrieval found nothing from it).
- **Small corpus.** 18 chunks is far less than real uploads, so retrieval is easier here than for a visitor with several long files. Compare retrieval with the random-picking figures above, not with 100%.
- **Failures.** Three answerable questions failed: the Arabic-document question asked in English (retrieval miss, refused), the two-document question about LAN ports and study rooms (the library chunk was not retrieved), and the router light question (both routers' chunks were retrieved, and the model refused). I read all 28 answers: the 22 passes are correct and the failures are real, so the scorer made no mistakes in this run. It can still miss a correct answer that uses different words.
- **Not measured:** token cost, and follow-up questions (the questions have no chat history).

### Run it

```bash
GEMINI_FALLBACK_MODEL=none npm run eval   # real run with ONE model: about one answer attempt per question (the app's own retries can add calls), about 5 minutes
npm run eval -- --retrieval-only  # free: retrieval scores only, no Gemini calls
npm run eval -- --retry-errors    # ask again only the questions that errored last time
```

It uses the models in `.env`. Unknown options are rejected (a typo never starts a paid run). Always pass `GEMINI_FALLBACK_MODEL=none` for a score: with a fallback, some answers come from a second model, the runner prints a warning, and each question records which model answered (`answeredBy`). Options: `--delay-ms N` (pause between Gemini calls, default 4000, to stay inside free-tier limits) and `--out FILE`. After 5 errors in a row it stops asking and marks the rest as skipped. Results go to `eval/results/latest.json` (a full run) or `eval/results/retrieval.json` (retrieval-only), not committed: the settings, the retrieved chunks with their scores, every answer, its checks and every line the app logged for it. An existing full-run file is moved to `latest.<date>.json` before a new run overwrites it. `--retry-errors` also resumes a run that stopped half way, as long as the models, settings, questions and documents are unchanged (do not use it with `eval/baseline.json`: a retry rewrites the file it reads, and the committed baseline is a finished record that must stay as it was run; the guard also refuses it once the settings or the question file have changed); a relative `--out` is resolved from the folder you run the command in. Questions that errored are reported separately and never counted as wrong.

**Testing the runner offline.** `EVAL_FAKE_LLM=<module>` (full runs only) swaps Gemini for the `{ llm, fallbackLlm }` that the module exports, so `test/evalRun.test.js` can check the stop after 5 errors, `--retry-errors`, and the warning for fallback answers without a key or a single Gemini call. Results made this way carry `fakeLlm: true` in their metadata, a retry refuses to mix them with real ones, and they must never be published.

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

# Responsive AI Document Chatbot

A chatbot that answers questions about your own documents. Upload PDF, Word, text or CSV files, then ask anything about them. Answers come only from the uploaded content using Retrieval-Augmented Generation (RAG). If the answer is not in your documents, the chatbot says so instead of guessing.

Every tool and service it uses is free.

**Live demo:** https://responsive-ai-chatbot.onrender.com (free hosting, so the first load can take about a minute)

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
│   │   ├── googleEmbeddings.js # Hosted Google embeddings (EMBEDDING_PROVIDER=google): batches, retries, errors
│   │   ├── embeddingFactory.js # Picks the embedder by EMBEDDING_PROVIDER (the local model code loads only when used)
│   │   ├── embeddingProfile.js # Prefixes, pooling, size and source-filter thresholds per embedding model
│   │   ├── embeddingErrors.js  # Embedding errors and their user messages (EMBEDDING_CONFIG, _AUTH, _RATE_LIMIT, _FAILED)
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
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Any Gemini model your key can use on the free tier. See the note below the table for why this is the default. |
| `GEMINI_FALLBACK_MODEL` | `gemini-3.1-flash-lite` | Second model, tried automatically when the main model is out of quota, overloaded, too slow or retired. It uses the same API key. `none` turns the fallback off. |
| `GEMINI_TIMEOUT_SECONDS` | `30` | Seconds each model gets to answer (its own retries included) before the fallback is tried. |
| `GEMINI_THINKING_LEVEL` | `minimal` | How much Gemini 3 models think before answering: `minimal`, `low`, `medium` or `high`. Less thinking saves free quota. `default` uses the model's own setting. `gemini-3.8-flash` has no `minimal` and gets `low` instead. |
| `GEMINI_THINKING_BUDGET` | `0` | Thinking tokens per answer for Gemini 2.5 models only. `0` turns thinking off; `default` uses the model's own setting. |
| `EMBEDDING_PROVIDER` | `local` | Where the embeddings are computed: `local` (a model in this process, no key) or `google` (Google's embeddings API with `GOOGLE_API_KEY`; see [Hosted embeddings (Google)](#hosted-embeddings-google), it sends your document text to Google). Anything else is ignored with a warning and `local` is used. |
| `EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` (`gemini-embedding-2` with the `google` provider) | Embedding model: from the Hugging Face Hub for `local`, a Gemini embedding model for `google`. The models in [Choosing an embedder](#choosing-an-embedder) already have the right prefixes and pooling built in. If you set the provider, set or remove this line too: a local model id with the `google` provider is a startup warning and an `EMBEDDING_CONFIG` error on upload. |
| `EMBEDDING_DTYPE` | `q8` | Local models only: model precision, `q8` (quantized, smallest) or `fp32`. |
| `EMBEDDING_THREADS` | `1` | Local models only: CPU threads for embeddings. |
| `EMBEDDING_QUERY_PREFIX`, `EMBEDDING_DOCUMENT_PREFIX` | from the model's profile | Text put before each question and before each document part. For a model that is not in the list, copy them from its model card (for example `"query: "` and `"passage: "` for E5). Put values with spaces in quotes; `\n` is a newline. Set but empty means no prefix. |
| `EMBEDDING_POOLING` | from the model's profile | Local models only: `mean`, `cls` or `last_token`. Any other value is ignored with a warning. |
| `EMBEDDING_SOURCE_MIN_SCORE`, `EMBEDDING_SOURCE_RELATIVE_SCORE` | from the model's profile | The sources shown when Gemini cites none are the chunks scoring at least `max(MIN, RELATIVE x the best score)`. The listed models have their own values (MiniLM `0.2` / `0.7`); another model gets those until you set them (see [Choosing an embedder](#choosing-an-embedder)). |
| `EMBEDDING_DIMENSIONS` | (full vector; `768` for the Google models) | Keep only the first N values of each vector, then scale it back to length 1. Only for models trained for it (EmbeddingGemma, Qwen3-Embedding). The app cannot check this for a model that is not in the list: cutting the vector of any other model can lower retrieval quality, so measure with `node eval/run.js --retrieval-only` first. For the Google models it is the size Google returns (128 to 3072). |
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

The two defaults are the `flash-lite` models because they were the ones that answered on a free key on 2026-11-24: `gemini-3.6-flash` returned 429 (quota) and `gemini-3.8-flash` returned 503 (busy). Free-tier quotas change, so check yours. A stronger model such as `gemini-3.6-flash` is one setting away.

Gemini models take different thinking settings. Gemini 3 models use a level (`thinkingLevel`) and reject a token budget; Gemini 2.5 models use the budget. The app builds the setting for each model (`src/services/thinking.js`) from a list of models whose accepted levels were checked against [Google's thinking page](https://aistudio.google.com/docs/thinking) and the live model list. For any model that is not on that list (for example `gemini-3.5-flash`, `gemini-3.7-flash` or a `gemini-4-*` model) it sends no thinking setting, so the model uses its own default. This matters because a wrong setting is a `400` error ("Request contains an invalid argument."): with the old defaults the fallback model rejected every call.

**Upgrading an old `.env`.** Before this change the defaults were `GEMINI_MODEL=gemini-3.5-flash`, `GEMINI_FALLBACK_MODEL=gemini-3.5-flash-lite` and `GEMINI_THINKING_BUDGET=0`. `gemini-3.5-flash` is not on the verified list, so it now gets no thinking setting, and the server logs `No thinking setting for gemini-3.5-flash; it uses its own default.` once at startup. The old `GEMINI_THINKING_BUDGET=0` has no effect on Gemini 3 models. To upgrade, set `GEMINI_MODEL=gemini-3.5-flash-lite` (or delete the line to take the default) and `GEMINI_THINKING_LEVEL=minimal`, and replace the fallback line the same way.

If the main model is out of quota, overloaded, too slow or retired, the server asks `GEMINI_FALLBACK_MODEL` instead and logs `LLM fallback: …`. A rejected key is not retried on the fallback, because it would fail there too. A `400` (the API rejected the request settings, usually the model name or a thinking setting) is not retried either, and it is never hidden: the answer is an `LLM_CONFIG` error that names the model and the setting to check (`GEMINI_MODEL` or `GEMINI_FALLBACK_MODEL`), even when the other model failed first, and the log says `config error`. (Google also answers a wrong API key with `400`; that stays an `LLM_AUTH` error. Another `400` that is not about a setting, such as `FAILED_PRECONDITION` for an unsupported location, can still show up as `LLM_CONFIG`.) If both models fail for other reasons, the error names the main model. If Google retires the model for good, set `GEMINI_MODEL` to another one, for example `gemini-flash-latest`, and restart the server.

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
- **Questions** (`eval/questions.jsonl`): 33 lines, each with the expected source file(s) and the key facts (phrases with their unit, such as `24 working days`, with accepted spellings). 20 English and 13 Arabic; 19 single-source, 2 cross-lingual (English question on an Arabic document and the reverse), 4 that need two documents, and 8 that the documents cannot answer. Five of those eight are near-misses (`none-04` to `none-08`): the R5 guide says solid green but the R7 manual has no green light, there is no Orbit R9, there is no study leave, the battery warranty is not stated, and the dental fee is not in the clinic's guide.
- **Scoring is deterministic, with no LLM judge.** A fact counts when its words appear as whole tokens in the answer (so `18` never matches `180`) and are not negated ("not 24 working days" does not count). The negation check is a heuristic, not language understanding. A negator counts only in the same clause as the fact (a clause ends at `.`, `,`, `:`, `;`, `?`, `!` or a bracket followed by a space), so "There is no limit: 24 working days" still passes. In English it counts as one of the two words before the fact ("not 24 days", "does not get 24 days") or as "not more/less than". In Arabic it counts up to four words before the fact, because Arabic negates the predicate that follows ("لا يجب الإلغاء قبل 24 ساعة" fails), unless a conditional or exception word (`إذا`, `لو`, `ما لم`, `إلا`, `وإلا`, `حتى`) comes earlier in the same clause ("تُحتسب رسوم إذا لم تلغ قبل 24 ساعة" passes). It can still pass a negation phrased another way, or fail a correct answer that happens to put a negator right before the fact, which is why failures are read by hand. Before comparing, the text is normalized: digits, thousands separators (`45,000`, `45 000`, `45.000`), times (`9:00 p.m.` = `9 pm`, `21:00` = `21`), `$40`, number words (`twelve` = `12`), Arabic spellings and hour words (`الساعة التاسعة صباحا` and `التاسعة صباحا` both mean `9 صباحا`), curly quotes and markdown (`eval/score.js`, tested in `test/evalScore.test.js`). Gold facts are checked when the eval starts (`eval/validate.js`): each must appear in the text of its source files, and none may already be in the question text (an answer that only repeats the question would score it). The runner also warns when a gold phrase appears in a document that is not an expected source. A few of these shared phrases cannot be avoided; they are listed in the question's `shared` field as `{ phrase: reason }`, and the check fails if an entry has no reason or no longer collides. A refusal counts only when the whole answer is the app's "I couldn't find that..." sentence and no sources are shown. Retrieval is deterministic (same documents, same embedder, same numbers every run); the answers are one sample from the model.

### Results

Run on 2026-11-24 with **one model**: `gemini-3.5-flash-lite` answered all 33 questions (`GEMINI_FALLBACK_MODEL=none`, thinking level `minimal`, no errors, no retries), embeddings `Xenova/all-MiniLM-L6-v2`, top-4 chunks, 5 seconds between calls. The full run is `eval/baseline.json`; its `gitCommit` (`71dbd25`) comes before the last documentation, retry-guard and negation-heuristic commits, which do not change how the stored answers score (rescored with the final scorer: the same 22/25). The earlier run, which mixed two models, is kept as `eval/baseline-mixed-2026-11-24.json`; it also scored 22/25 correct on the same answerable questions.

| Measure (95% interval in brackets) | All | English | Arabic |
| --- | --- | --- | --- |
| Answerable questions | 25 | 15 | 10 |
| Retrieval: every expected file in the top 4 chunks (random picking: 43%) | 23/25 (92%) [75-98] | 13/15 (87%) [62-96] | 10/10 (100%) [72-100] |
| Retrieval: first chunk is from an expected file (random picking: 16%) | 13/25 (52%) [33-70] | 13/15 (87%) [62-96] | 0/10 (0%) [0-28] |
| Answer correct (every key fact present) | 22/25 (88%) [70-96] | 12/15 (80%) [55-93] | 10/10 (100%) [72-100] |
| Answer correct and every expected source shown (stricter) | 22/25 (88%) [70-96] | 12/15 (80%) [55-93] | 10/10 (100%) [72-100] |
| Unanswerable questions refused correctly (8, five of them near-misses) | 8/8 (100%) [68-100] | 5/5 [57-100] | 3/3 [44-100] |

By question type, answers were correct for 18/19 single-source, 1/2 cross-lingual and 3/4 two-document questions. All five near-miss questions (`none-04` to `none-08`) were refused. Two answerable questions were wrongly refused. Answer time per question: median 1.3s, mean 1.8s, longest 8.0s.

### What the numbers mean

- **It is a small set.** With 25 answerable questions, one question is about 4 points, and the intervals above are wide (an 88% score could be anywhere from 70% to 96%). Retrieval is the same on every run; the answers are one sample, and Gemini answers can vary between runs. Treat the table as a baseline to compare against, not as a precise score.
- **One model, one sample.** Every answer came from `gemini-3.5-flash-lite` with the fallback off. A stronger model (`gemini-3.6-flash`) returned 429 (quota) on the free tier when this was run, so it was not compared.
- **Arabic retrieval does not work yet; the Arabic answers only look good.** The embedding model is trained on English. For 13 of 13 Arabic questions the same chunk (`shifa-center-guide-ar.txt`, part 2) came first, and the right chunk was never first. The answers were still correct because this set has only 6 Arabic chunks, so the top 4 almost always contains the right one. With more Arabic documents this will fail. An English question about an Arabic document was refused (retrieval found nothing from it).
- **Small corpus.** 18 chunks is far less than real uploads, so retrieval is easier here than for a visitor with several long files. Compare retrieval with the random-picking figures above, not with 100%.
- **Failures.** Three answerable questions failed: the router light question `en-05` (both routers' chunks were retrieved, and the model refused), the Arabic-document question asked in English `x-01` (retrieval miss, refused), and the two-document question about LAN ports and study rooms `multi-02` (the library chunk was not retrieved, so the model answered the first half and said it could not find the second). I read all 33 answers: the 22 passes are correct, the 3 failures are real, and the 8 refusals are correct, so the scorer made no mistakes in this run. It can still miss a correct answer that uses different words.
- **Not measured:** token cost, and follow-up questions (the questions have no chat history).

### Run it

```bash
GEMINI_FALLBACK_MODEL=none npm run eval   # real run with ONE model: about one answer attempt per question (the app's own retries can add calls), about 5 minutes
npm run eval -- --retrieval-only  # free: retrieval scores only, no Gemini calls
npm run eval -- --retry-errors    # ask again only the questions that errored last time
```

It uses the models in `.env`. Unknown options are rejected (a typo never starts a paid run). Always pass `GEMINI_FALLBACK_MODEL=none` for a score: with a fallback, some answers come from a second model, the runner prints a warning, and each question records which model answered (`answeredBy`). Options: `--delay-ms N` (pause between Gemini calls, default 4000, to stay inside free-tier limits) and `--out FILE`. After 5 errors in a row it stops asking and marks the rest as skipped. Results go to `eval/results/latest.json` (a full run) or `eval/results/retrieval.json` (retrieval-only), not committed: the settings, the retrieved chunks with their scores, every answer, its checks and every line the app logged for it. An existing full-run file is moved to `latest.<date>.json` before a new run overwrites it. `--retry-errors` also resumes a run that stopped half way, as long as the models, settings, questions and documents are unchanged (it refuses a file where every question already has an answer, so `eval/baseline.json` cannot be rewritten by a retry; it also refuses a file once the models, settings or question file have changed); a relative `--out` is resolved from the folder you run the command in. Questions that errored are reported separately and never counted as wrong.

**Testing the runner offline.** `EVAL_FAKE_LLM=<module>` (full runs only) swaps Gemini for the `{ llm, fallbackLlm }` that the module exports, so `test/evalRun.test.js` can check the stop after 5 errors, `--retry-errors`, and the warning for fallback answers without a key or a single Gemini call. Results made this way carry `fakeLlm: true` in their metadata, a retry refuses to mix them with real ones, and they must never be published.

## Choosing an embedder

The embedder decides which parts of your documents Gemini gets to read. The default, `Xenova/all-MiniLM-L6-v2`, is English-only: in the evaluation above the same Arabic chunk came first for 13 of 13 Arabic questions. This section compares four multilingual models that run in Transformers.js with the baseline. Measured on 2026-11-24 with `node eval/embedders.js`: each model in its own process, `q8`, one thread, top-4, the same 8 documents and 25 answerable questions, no Gemini calls. The numbers are in `eval/results/embedders-2026-11-24.json`.

**Short answer: none of the four fits Render's 512 MB, so the default stays MiniLM.** The smallest one, `multilingual-e5-small`, fixes Arabic retrieval but needs about 860 MB in the real server (MiniLM: 431 MB in the same test). It is the one to use on a host with at least 1 GB of RAM.

### Retrieval (95% interval in brackets)

| Model | Every expected file in the top 4 | Right chunk in the top 4 | First chunk is from an expected file | English first chunk | Arabic first chunk | Arabic: different chunks first |
| --- | --- | --- | --- | --- | --- | --- |
| MiniLM (default) | 23/25 [75-98] | 23/25 [75-98] | 13/25 [33-70] | 13/15 | 0/10 [0-28] | 1 (the same one 13 of 13 times) |
| `multilingual-e5-small` | 25/25 [87-100] | 24/25 [80-99] | 23/25 [75-98] | 13/15 | 10/10 [72-100] | 4 |
| `multilingual-e5-base` | 25/25 [87-100] | 25/25 [87-100] | 24/25 [80-99] | 14/15 | 10/10 [72-100] | 4 |
| `embeddinggemma-300m` | 25/25 [87-100] | 24/25 [80-99] | 23/25 [75-98] | 13/15 | 10/10 [72-100] | 4 |
| `Qwen3-Embedding-0.6B` | 25/25 [87-100] | 23/25 [75-98] | 24/25 [80-99] | 14/15 | 10/10 [72-100] | 5 |

"Right chunk" is the strict version of the first column: every gold fact of the question is in the text of a retrieved chunk that comes from an expected file (the file-level hit only asks for the right file).

What this shows:

- **Arabic retrieval is fixed by any of the four.** Arabic first-chunk accuracy goes from 0/10 to 10/10, and the first chunk is no longer the same one every time. (In the e5 runs one clinic chunk comes first for 8 of 13 Arabic questions; 5 are single-source questions about that clinic, 1 is a two-document question that needs it and 2 are near-miss questions about it, so this is the right chunk, not a collapse.)
- **The four models are tied.** The first-chunk column differs by one question out of 25 (23 or 24) and the right-chunk column by two (23 to 25), well inside the intervals. The "every expected file" and "right chunk" columns are not a significant gain over MiniLM either: [75-98] overlaps [87-100] and [80-99]. The first-chunk gain (13/25 to 23/25) and the Arabic gain are not noise.
- **"Hit" means the right file, not the right chunk.** At chunk level Qwen3 is no better than MiniLM (23/25 both) and e5-small, EmbeddingGemma and Qwen3 miss 1 to 2 questions that the file-level column counts as hits. With e5-small `en-02` (probation period) retrieved the right file but not the chunk that holds the answer, and Gemini refused. Judge the models by the right-chunk and first-chunk columns.

### Cost

| Model | Download | Load (cached) | Embed 18 chunks | Search (query embedded) | Peak memory, eval process | Real server after uploads |
| --- | --- | --- | --- | --- | --- | --- |
| MiniLM (default) | 23 MB | 0.05 s | 0.4 s | 2 ms | 397 MB | 431 MB |
| `multilingual-e5-small` | 129 MB | 0.25 s | 0.5 s | 3 ms | **786 MB** | **861 MB** |
| `multilingual-e5-base` | 282 MB | 0.3 s | 1.1 s | 7 ms | **1,169 MB** | not run |
| `embeddinggemma-300m` | 316 MB | 0.5 s | 1.5 s | 68 ms | **1,737 MB** | not run |
| `Qwen3-Embedding-0.6B` | 596 MB | 0.5 s | 9.3 s | 83 ms | **1,977 MB** | not run |

Bold means above the 450 MB line that this project treats as "near the limit" on a 512 MB host. Peak memory is the whole `eval/run.js` process (`process.resourceUsage().maxRSS`, with the app's libraries loaded), so compare models with each other, not with 512 MB directly. The last column boots `npm start` with the model, uploads the 8 documents in three separate sessions and reads the process memory with `ps`; it is one sample per model. Times are from one Apple M5 laptop, one run per model; Render's CPU will give other numbers. Two full runs gave peak memory within 25 MB of each other.

Why the memory is so high: the multilingual models have a vocabulary of 250,000 to 262,000 tokens. The quantized file is small (118 MB for e5-small), but onnxruntime expands the embedding table when it loads the model. That takes about 480 MB of native memory for e5-small, plus about 190 MB of JavaScript heap for its tokenizer. MiniLM uses 177 MB in total after loading. The `fp16` and `q4f16` files of e5-small were worse: about 1,090 and 990 MB after embedding, against 740 MB for `q8`. Turning off the onnxruntime memory arena or its graph optimisation changed the memory after loading by less than 30 MB. So `q8` is already the lightest option. `bge-m3` was not run: its quantized file alone is 570 MB.

### Effect on answers (one run)

One real run with `multilingual-e5-small` (`gemini-3.5-flash-lite`, no fallback, 33 questions): 24/25 answerable questions correct, against 22/25 with MiniLM. Three earlier failures are fixed (`en-05`, `x-01`, `multi-02`) and one is new (`en-02`, the chunk problem above). The refusals were correct for 8/8 questions by hand, but only 6/8 use the exact "I couldn't find that" sentence: for `none-07` and `none-08` Gemini refused in Arabic. With 25 questions and one sample, 22/25 [70-96] and 24/25 [80-99] overlap, so treat this as a direction, not a result.

### If you switch

- Set `EMBEDDING_MODEL=Xenova/multilingual-e5-small` and restart. The prefixes (`query: ` for questions, `passage: ` for document parts) and pooling are applied for you; nothing is stored on disk, so there is nothing to re-index. An unlisted model gets mean pooling and no prefixes, with a warning at startup.
- The sources shown when Gemini cites none are the chunks that score at least `max(sourceMinScore, sourceRelativeScore x best score)`. These two thresholds belong to the model's profile (`src/services/embeddingProfile.js`), because scores differ a lot between models: MiniLM's are spread over 0 to 0.7, e5's sit between 0.7 and 0.9. MiniLM keeps its original 0.2 / 0.7, so the default behaves exactly as before. With that rule e5 showed all 4 chunks for 33 of 33 questions. The other models now have their own rule, calibrated in-sample on the same 25 answerable questions they are measured on, so read it as a starting point and not as a proven setting (best F1 between the chunks shown and the chunks of the expected files, minimum fixed at 0.2, relative score on a 0.05 grid; for e5 0.92 because 0.90 and 0.94 are within 0.03):

  | Model | Relative score | F1 with MiniLM's 0.7 | F1 with its own | Chunks shown on average (33 questions) |
  | --- | --- | --- | --- | --- |
  | `multilingual-e5-small` | 0.92 | 0.73 | 0.80 | 3.3 (was 4.0) |
  | `multilingual-e5-base` | 0.92 | 0.74 | 0.83 | 3.3 (was 4.0) |
  | `embeddinggemma-300m` | 0.55 | 0.79 | 0.87 | 3.2 (was 2.4) |
  | `Qwen3-Embedding-0.6B` | 0.8 | 0.78 | 0.79 | 2.8 (was 3.6) |

  This is better but not fixed: e5 scores are so close together that its rule still shows 3 or 4 chunks for many questions. The F1 values above are in-sample (tuned and measured on the same 25 questions), so they overstate how well the rule will work on other documents. When the model cites its sources, none of this applies. For a model that is not in the table, the MiniLM rule is used with a startup warning; set `EMBEDDING_SOURCE_MIN_SCORE` and `EMBEDDING_SOURCE_RELATIVE_SCORE` after looking at its scores (the eval prints the top scores).
- `EmbeddingGemma` is called through its own `sentence_embedding` output (the ONNX graph pools and projects the vector itself), not through the feature-extraction pipeline, which would return the wrong vectors for it.

### Licences of the models

Checked on the model pages on huggingface.co on 2026-11-24. The ONNX copies that Transformers.js downloads (`Xenova/...`, `onnx-community/...`) are conversions: the e5 and Qwen3 copies have no licence field of their own and name the original model as their base, so the original's licence applies.

| Model | Licence |
| --- | --- |
| `Xenova/all-MiniLM-L6-v2` (default) | Apache-2.0 |
| `multilingual-e5-small` / `-base` (original `intfloat/...`) | MIT |
| `Qwen3-Embedding-0.6B` (original `Qwen/...`) | Apache-2.0 |
| `embeddinggemma-300m` | Gemma Terms of Use (licence `gemma`, <https://ai.google.dev/gemma/terms>), with the Gemma Prohibited Use Policy. It is not an open-source licence: read it before using the model in a product |

### Limits of this comparison

18 chunks and 25 answerable questions are a small test: with so little text, retrieval is easier than for real uploads, and the intervals are wide. File-level hits are generous (see `en-02`). The timings come from one machine and one run. Memory on Render was not measured. Nothing was fine-tuned or published.

Run it: `node eval/embedders.js` (all models, downloads them once, about 5 minutes) or `node eval/embedders.js --only e5-small`. The raw runs go to `eval/results/embedders-raw/` and are not committed.

## Hosted embeddings (Google)

The local embedders in [Choosing an embedder](#choosing-an-embedder) fix Arabic retrieval but need 790 MB or more, and Render's free plan has 512 MB. The other way to get a multilingual embedder is to not run one: send the text to Google's embeddings API. Set this in `.env` and restart:

```env
EMBEDDING_PROVIDER=google
EMBEDDING_MODEL=gemini-embedding-2     # or gemini-embedding-001; leave the line out for gemini-embedding-2
```

It uses the same `GOOGLE_API_KEY` as the answers, adds no dependency (a small `fetch` client in `src/services/googleEmbeddings.js`) and never loads the local model code, so the server stays small. The default is still `local` (MiniLM), so nothing changes until you set it. Vectors are stored at 768 values (`EMBEDDING_DIMENSIONS`, 128 to 3072 allowed): the API returns 3072 by default, which would take about 123 MB of JavaScript numbers for 5,000 chunks against about 31 MB at 768. Nothing is stored on disk, so there is nothing to re-index when you switch, but vectors of two different models can never be mixed.

How each model is called (from the [Gemini embeddings docs](https://aistudio.google.com/docs/embeddings), read on 2026-11-24):

| | `gemini-embedding-2` (default, recommended by Google) | `gemini-embedding-001` |
| --- | --- | --- |
| Task (question vs document part) | Text prefix: `task: search result \| query: ` and `title: none \| text: `. It takes no `taskType`. | `taskType` `RETRIEVAL_QUERY` / `RETRIEVAL_DOCUMENT`, no prefix |
| Input limit | 8,192 tokens | 2,048 tokens |
| Vector size | 3072 by default, `outputDimensionality` 128 to 3072 | the same |
| Reduced vectors are normalised by Google | yes | no: the app scales every vector to length 1 itself |
| Status | stable, no shutdown announced | not before 2028-05-14 |

The two models make vectors that cannot be compared with each other or with any local model.

### Measured

Same 8 documents (18 chunks), 25 answerable questions and top 4 as above. Command: `node eval/embedders.js --only google-embedding-2` (and `-001`), one run each on 2026-11-24. The laptop was in Saudi Arabia, so every time includes the network round trip. Intervals are 95% Wilson.

| | MiniLM (default, local) | `multilingual-e5-small` (local) | `gemini-embedding-2` | `gemini-embedding-001` |
| --- | --- | --- | --- | --- |
| Every expected file in the top 4 | 23/25 [75-98] | 25/25 [87-100] | 25/25 [87-100] | 25/25 [87-100] |
| Right chunk in the top 4 | 23/25 [75-98] | 24/25 [80-99] | 24/25 [80-99] | 24/25 [80-99] |
| First chunk is from an expected file | 13/25 [33-70] | 23/25 [75-98] | 23/25 [75-98] | 25/25 [87-100] |
| English questions, first chunk | 13/15 [62-96] | 13/15 [62-96] | 13/15 [62-96] | 15/15 [80-100] |
| Arabic questions, first chunk | 0/10 [0-28] | 10/10 [72-100] | 10/10 [72-100] | 10/10 [72-100] |
| Embedding the 18 chunks (8 uploads) | 0.4 s | 0.5 s | 5.8 s | 4.7 s |
| One question embedded (mean / median) | 2 ms | 3 ms | 525 / 507 ms | 393 / 388 ms |
| Peak memory, `eval/run.js` process | 397 MB | 786 MB | 241 MB | 240 MB |
| Memory of the real server (`npm start`) | 431 MB after uploads | 861 MB after uploads | 187 MB idle, 228 MB after uploads and a question | not run |
| API calls in the run | none | none | 41 | 41 |

What this shows:

- **Arabic works, at a quarter of the memory.** Both Google models match e5-small on Arabic (first chunk right for 10 of 10), and the process stays near 240 MB instead of 786 MB. The real server held 228 MB after the 8 uploads and an Arabic question about the English HR policy. The answer was correct and showed its source.
- **No quality difference between the models at this size.** `gemini-embedding-001` has the best first-chunk result (25/25), two questions more than `gemini-embedding-2` (23/25). The intervals [87-100] and [75-98] overlap, and every multilingual option has the same right-chunk count (24/25). Try both on your own documents. Google recommends `2`.
- **It is slower.** Every question needs one network call (about 0.4 to 0.5 s here) before Gemini is asked. An upload makes one call per 16 parts, so a 40-part file is 3 calls. The 41 calls were 8 uploads (one call each, because every document has under 16 parts) and 33 questions.
- Source filter: both models have their own thresholds (`0.2` / `0.85`), calibrated in-sample on these 25 questions like the others (F1 0.87 and 0.86 against 0.79 and 0.77 with MiniLM's rule), so a starting point only. The scores of these models are close together (0.5 to 0.82), so the same caveat as for e5 applies.

### Effect on answers (one run)

One real run with `gemini-embedding-2` (`gemini-3.5-flash-lite`, no fallback, 33 questions, `--delay-ms 5000`): 24/25 answerable questions correct [80-99], against 22/25 [70-96] with MiniLM and 24/25 with e5-small. The one failure is `en-06` (reset button of the Orbit R7): the right file was retrieved but not the part that holds the answer, and Gemini refused. All 8 unanswerable questions were refused with the exact "I couldn't find that" sentence and no source (e5-small: 6 of 8 exact). With 25 questions and one sample the intervals overlap, so this is a direction, not a result. The run made 74 embedding calls (8 uploads, plus 33 questions embedded twice: once to score retrieval and once to answer) and no errors or retries.

### Quota and cost

- **Free tier:** both models are free of charge on the free tier. Google does not publish per-model limits (requests, tokens per minute, requests per day) in its docs. AI Studio shows them for your project. Limits are per project, so **embeddings and the chat answers share one quota**. Every question now costs two calls (one embedding, one answer) and an upload costs one call per 16 parts. About 200 embedding calls in an afternoon (three retrieval runs, one of them repeated, one answer run and a few smoke calls) hit no 429. That is one sample from one project on one day, not a limit: your quota can be lower or change.
- **Paid:** $0.20 (`gemini-embedding-2`) or $0.15 (`gemini-embedding-001`) per million input tokens, half that for the batch API (which this app does not use). A 1,000-character part is roughly 250 to 400 tokens (my estimate, not measured), so 1,000 parts cost a few cents.
- **When Google answers 429 or 5xx**, the app retries up to 3 times with a growing wait. It follows `Retry-After`, capped at 5 s. Every call, waits included, ends within 20 s. After that the visitor sees `EMBEDDING_RATE_LIMIT` ("wait a minute and try again") or `EMBEDDING_FAILED`, and an upload that fails half way adds nothing: no part of the document is kept and the space it reserved is given back. A visitor who closes the page during an upload stops the remaining calls.

| Code | Meaning | What to do |
| --- | --- | --- |
| `EMBEDDING_AUTH` | Google rejected the key (it answers a wrong key with HTTP 400 `API_KEY_INVALID`, not 401) | Check `GOOGLE_API_KEY` |
| `EMBEDDING_RATE_LIMIT` | Out of quota after the retries | Wait, or look at your limits in AI Studio |
| `EMBEDDING_CONFIG` | Google rejected a setting (unknown model, a size outside 128 to 3072, ...) | Check `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL` and `EMBEDDING_DIMENSIONS` |
| `EMBEDDING_FAILED` | Google could not be reached or was busy after the retries | Try again |
| `MISSING_API_KEY` | No `GOOGLE_API_KEY` (the server also warns at startup) | Add it |

The key is only sent in the `x-goog-api-key` header. It is in no URL, log line, error or message. Text that Google sends back is scrubbed of key-like strings before the app keeps it.

### Trade-offs

- **Privacy: the text of every uploaded document goes to Google.** With the local models only the question and (at answer time) up to four retrieved parts leave your server. With `EMBEDDING_PROVIDER=google` every part of every uploaded document is sent to Google when it is uploaded, before anyone asks anything. [Google's terms](https://aistudio.google.com/docs/terms) say that on the unpaid (free) tier, submitted content is used to improve its products and human reviewers may read it. They advise against sending confidential or personal information. Paid services do not train on it. In the EEA, Switzerland and the UK, the paid terms apply to every service. With `EMBEDDING_PROVIDER=google` the page shows the notice "Your documents are processed by Google to answer questions." under the upload area (and above the message box on small screens) automatically: it learns the provider from `GET /api/health` (`embeddingProvider`), and nothing is shown with the local provider.
- **Network on every question and upload.** Each question takes about half a second longer, and nothing works when Google is unreachable. The local embedder needs the network once, to download the model.
- **Quota shared with the answers**, as above.
- **Not reproducible forever.** Hosted models can be retired (`text-embedding-004` and `embedding-001` already were): a retirement means re-embedding, which here happens by itself on the next upload because nothing is stored.

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

Uploaded documents stay in memory only and are private to your browser. The server never saves them to disk. The text of your questions and the parts of your documents that answer them are sent to Google's Gemini to write the answer; with `EMBEDDING_PROVIDER=google` the text of every uploaded document is also sent to Google for embedding (see [Hosted embeddings (Google)](#hosted-embeddings-google)). Closing the browser ends your access to them, and the server deletes them after 30 minutes without activity or when it restarts. When that happens, the page clears the old conversation and shows a note asking you to upload your files again. Each visitor can keep up to 10 documents.

## API

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/api/health` | | `{ status, llmConfigured, model, fallbackModel, embeddingProvider }` (`embeddingProvider` is `local` or `google`) |
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

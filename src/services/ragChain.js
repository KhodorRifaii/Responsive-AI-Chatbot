import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { StringOutputParser } from '@langchain/core/output_parsers';
import config from '../config.js';
import { search, hasDocuments } from './vectorStore.js';
import { HttpError } from '../utils/httpError.js';

const MAX_MESSAGE_LENGTH = 2000;

// @google/generative-ai (inside @langchain/google-genai 2.3.7) returns a `response` promise next to
// every stream, and LangChain never awaits it. When a stream is aborted (our timeout) or the
// connection drops, that promise rejects with no handler and Node would exit, taking every
// visitor's documents with it. The same error already reaches streamWithFallback through the
// stream itself, so this copy is only logged. Any other unhandled rejection still stops the process.
process.on('unhandledRejection', (reason) => {
  if (/^GoogleGenerativeAI(Abort)?Error$/.test(reason?.constructor?.name ?? '') && /reading from the stream/.test(reason.message)) {
    console.warn('Ignored a duplicate Gemini stream error:', reason.message);
    return;
  }
  console.error('Unhandled promise rejection:', reason);
  process.exit(1);
});

export const NOT_FOUND_ANSWER = "I couldn't find that in your uploaded documents.";

const SYSTEM_PROMPT = `You are a document assistant. Answer the user's question using ONLY the context below.
The context contains excerpts from documents the user uploaded.

Rules:
- Use only facts stated in the context. Never use outside knowledge, and never guess.
- You may do simple reasoning on those facts: unit conversions, totals, comparisons and dates (for example, 90 minutes is 1.5 hours).
- If the context does not contain the facts needed for the answer, reply exactly: "${NOT_FOUND_ANSWER}"
- Be concise and clear. Use short lists when they help.
- Answer in the same language as the question.
- Use the earlier conversation only to understand follow-up questions; facts must still come from the context.
- End with one last line listing the numbers of the context excerpts you used, like: SOURCES: 1, 3
  If you could not find the answer, end with: SOURCES: none

Context:
{context}`;

const prompt = ChatPromptTemplate.fromMessages([
  ['system', SYSTEM_PROMPT],
  new MessagesPlaceholder('history'),
  ['human', '{question}'],
]);

export function createLlm(model = config.geminiModel) {
  if (!config.googleApiKey) {
    throw new HttpError(503, 'MISSING_API_KEY', 'The AI is not set up yet: add GOOGLE_API_KEY to the .env file and restart the server. You can get a free key at aistudio.google.com.');
  }
  return new ChatGoogleGenerativeAI({
    model,
    apiKey: config.googleApiKey,
    temperature: 0.2,
    // Fail fast when Gemini is overloaded instead of retrying for a minute or more.
    maxRetries: 2,
    // Thinking off by default: about 6x fewer tokens per answer, and simple maths still works.
    ...(config.geminiThinkingBudget === null ? {} : { thinkingConfig: { thinkingBudget: config.geminiThinkingBudget } }),
  });
}

// Fallback when the model does not cite: show chunks clearly related to the question.
const MIN_SOURCE_SCORE = 0.2;
const RELATIVE_SOURCE_SCORE = 0.7;
// The last line "SOURCES: 1, 3" / "SOURCES: none" (any case, optional ** and colon). It may also
// end the last sentence ("… 18 months. SOURCES: 1"), but then it needs the colon. Only "none" or
// numbers may follow, with commas, "and", ranges or brackets ("[1], [3]", "1 and 3", "1-3"), so a
// last sentence like "The sources are in the appendix." stays.
const CITED = '(none|(?:[\\d,;&()\\[\\]\\- \\t]|and\\b)*)\\.?[ \\t]*\\**';
const SOURCES_LINE = new RegExp(`(?:(?:^|\\n)[ \\t]*\\**SOURCES\\**[ \\t]*:?\\**[ \\t]*${CITED}|[ \\t]+\\**SOURCES\\**[ \\t]*:\\**[ \\t]*${CITED})\\s*$`, 'i');

/** Split the model output into the answer and the context numbers it cited (null = no SOURCES line). */
export function splitCitations(output) {
  const match = output.match(SOURCES_LINE);
  if (!match) return { answer: output.trim(), cited: null };
  const cited = [...(match[1] ?? match[2]).matchAll(/\d+/g)].map((m) => Number(m[0]));
  return { answer: output.slice(0, match.index).trim(), cited };
}

function pickSourceChunks(results, cited) {
  if (cited) {
    return cited.map((n) => results[n - 1]?.[0]).filter(Boolean);
  }
  const best = results[0]?.[1] ?? 0;
  const threshold = Math.max(MIN_SOURCE_SCORE, best * RELATIVE_SOURCE_SCORE);
  return results.filter(([, score]) => score >= threshold).map(([chunk]) => chunk);
}

const EXCERPT_LENGTH = 280;
const STOP_WORDS = new Set(['the', 'and', 'for', 'are', 'was', 'what', 'which', 'how', 'does', 'did', 'with', 'that', 'this', 'from', 'your', 'you', 'can', 'its', 'has', 'have', 'about', 'there', 'when', 'where', 'who', 'much', 'many']);

function keywords(text) {
  // Numbers always count ("10", "22"); short words and common question words don't.
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((w) => /\d/.test(w) || (w.length > 2 && !STOP_WORDS.has(w))));
}

/**
 * Pick the part of a chunk that matters for this answer: start at the sentence
 * (or CSV row) sharing the most words with the question and answer. Words that
 * appear in many sentences of the chunk ("days", "year") count less than rare ones ("sick").
 */
function bestExcerpt(text, focusWords) {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const sentenceWords = sentences.map(keywords);
  const frequency = new Map();
  for (const words of sentenceWords) for (const w of words) frequency.set(w, (frequency.get(w) ?? 0) + 1);

  let bestIndex = 0;
  let bestScore = 0;
  sentenceWords.forEach((words, index) => {
    let score = 0;
    for (const word of focusWords) if (words.has(word)) score += 1 / frequency.get(word);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  const excerpt = sentences.slice(bestIndex).join(' ');
  const prefix = bestIndex > 0 ? '…' : '';
  return excerpt.length > EXCERPT_LENGTH ? `${prefix}${excerpt.slice(0, EXCERPT_LENGTH)}…` : `${prefix}${excerpt}`;
}

/** Short, de-duplicated list of the chunks an answer was based on. */
function toSources(chunks, focusText = '') {
  const focusWords = keywords(focusText);
  const seen = new Set();
  return chunks
    .filter((chunk) => {
      const key = `${chunk.metadata.docId}:${chunk.metadata.chunk}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((chunk) => {
      return {
        source: chunk.metadata.source,
        page: chunk.metadata.page ?? null,
        chunk: chunk.metadata.chunk,
        excerpt: bestExcerpt(chunk.pageContent, focusWords),
      };
    });
}

function formatContext(chunks) {
  return chunks
    .map((chunk, index) => {
      const { source, page } = chunk.metadata;
      const label = page ? `${source}, page ${page}` : source;
      return `[${index + 1}] (${label})\n${chunk.pageContent}`;
    })
    .join('\n\n');
}

/** Keep the last few valid turns and turn them into LangChain messages. */
function toChatHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-config.maxHistoryMessages)
    // Same limit as a question, so a tampered history can't send huge prompts to Gemini.
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_LENGTH) }))
    .map((m) => (m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content)));
}

/**
 * Build the retrieval query. Follow-ups like "and the price?" need the
 * previous user question to find the right chunks.
 */
function buildSearchQuery(question, history) {
  const lastUserMessage = [...history].reverse().find((m) => m._getType() === 'human');
  return lastUserMessage ? `${lastUserMessage.content}\n${question}` : question;
}

/** A model took longer than GEMINI_TIMEOUT_SECONDS. */
export class LlmTimeoutError extends Error {
  constructor() {
    super(`No answer within ${config.geminiTimeoutSeconds} seconds.`);
    this.name = 'LlmTimeoutError';
  }
}

const errorStatus = (error) => Number(error?.status ?? error?.response?.status) || 0;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_TEXT = /quota|rate.?limit|resource.?exhausted|overloaded|high demand|unavailable|timed? ?out|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|model.*not found/i;

/**
 * Errors another model may not have: quota, overload, timeouts, network problems and a
 * retired model (404). Bad requests and key problems would fail on every model.
 */
export function isRetryableLlmError(error) {
  if (error instanceof LlmTimeoutError) return true;
  const status = errorStatus(error);
  if (RETRYABLE_STATUS.has(status)) return true;
  // 404 only when the model itself is unknown or retired ("models/x is not found").
  if (status === 404) return /model/i.test(String(error?.message ?? ''));
  if (status === 400 || status === 401 || status === 403) return false;
  const text = String(error?.message ?? '');
  return !/api.?key|permission|thinking/i.test(text) && RETRYABLE_TEXT.test(text);
}

/** Short reason for logs: status and the start of the provider message (never the prompt). */
function describeError(error) {
  const status = errorStatus(error);
  const text = String(error?.message ?? error).split('\n')[0].slice(0, 120);
  return status ? `${status} ${text}` : text;
}

/**
 * Run one model call with GEMINI_TIMEOUT_SECONDS; a timeout aborts the request. Streams call
 * touch() for each piece of text, so the limit is the wait for the next piece, not the whole answer.
 */
async function withTimeout(call) {
  const controller = new AbortController();
  const ms = config.geminiTimeoutSeconds * 1000;
  let timer = setTimeout(() => controller.abort(), ms);
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), ms);
  };
  try {
    // @langchain/google-genai ends a stream quietly when aborted, hence the check after the call too.
    const result = await call(controller.signal, touch);
    if (controller.signal.aborted) throw new LlmTimeoutError();
    return result;
  } catch (error) {
    throw controller.signal.aborted ? new LlmTimeoutError() : error;
  } finally {
    clearTimeout(timer);
  }
}

/** The models to try in order: the main model, then the fallback (if set). */
function modelAttempts(llm, fallbackLlm) {
  if (llm) {
    return [{ name: llm.model ?? 'main model', llm }, ...(fallbackLlm ? [{ name: fallbackLlm.model ?? 'fallback model', llm: fallbackLlm }] : [])];
  }
  const attempts = [{ name: config.geminiModel, llm: createLlm() }];
  if (config.geminiFallbackModel) attempts.push({ name: config.geminiFallbackModel, llm: createLlm(config.geminiFallbackModel) });
  return attempts;
}

/**
 * Ask each model in turn. Move to the next one only for errors another model may not have
 * (quota, overload, timeout, retired model); otherwise, or when all fail, report the main
 * model's error, because GEMINI_MODEL is the setting the user can fix.
 */
async function invokeWithFallback(attempts, input) {
  let firstError;
  for (const [index, { name, llm }] of attempts.entries()) {
    const chain = prompt.pipe(llm).pipe(new StringOutputParser());
    try {
      const answer = await withTimeout((signal) => chain.invoke(input, { signal }));
      if (index > 0) console.warn(`LLM answered with fallback model ${name}.`);
      return answer;
    } catch (error) {
      firstError ??= error;
      const next = attempts[index + 1];
      if (!next || !isRetryableLlmError(error)) break;
      console.warn(`LLM fallback: ${name} failed (${describeError(error)}), trying ${next.name}.`);
    }
  }
  throw toLlmError(firstError);
}

// Text from a candidate position that could still become the final SOURCES line (see
// SOURCES_LINE), also while it is incomplete: at a line start the colon is optional, after a
// sentence it is required. Anything after a newline must be blank (the line must be the last).
const MAYBE_CITED = '(?:n(?:o(?:n(?:e)?)?)?|(?:[\\d,;&()\\[\\]\\- \\t]|a(?:n(?:d)?)?)*)\\.?[ \\t]*\\**[ \\t]*';
const MAYBE_SOURCES_AT_LINE_START = new RegExp(`^\\**sources\\**[ \\t]*:?\\**[ \\t]*${MAYBE_CITED}(?:\\n\\s*)?$`, 'i');
const MAYBE_SOURCES_IN_LINE = new RegExp(`^\\**sources\\**[ \\t]*(?::\\**[ \\t]*${MAYBE_CITED})?(?:\\n\\s*)?$`, 'i');

/**
 * Hides the final "SOURCES: …" line while an answer streams. Text from a word that may be
 * that line (or may still grow into it, like a trailing "So" or "**") is held back until the
 * next pieces decide; ordinary text that only contains the word "sources" is shown.
 * push(piece) returns the text that is safe to show now. The final answer is always
 * recomputed from the full text with splitCitations().
 */
export function createSourcesFilter() {
  let pending = '';
  let lastShown = '\n'; // last character already shown ("\n" at the start of the answer)
  let shownLineBlank = true; // the shown part of the current line is only spaces
  const blank = (text) => /^[ \t]*$/.test(text);

  const atLineStart = (p) => {
    const newline = pending.lastIndexOf('\n', p - 1);
    return newline >= 0 ? blank(pending.slice(newline + 1, p)) : shownLineBlank && blank(pending.slice(0, p));
  };

  const holdsFrom = (p) => {
    if (!/\s/.test(p === 0 ? lastShown : pending[p - 1])) return false;
    const rest = pending.slice(p);
    const word = /^\**([a-z]*)$/i.exec(rest);
    if (word && 'sources'.startsWith(word[1].toLowerCase())) return true;
    return (atLineStart(p) ? MAYBE_SOURCES_AT_LINE_START : MAYBE_SOURCES_IN_LINE).test(rest);
  };

  return {
    push(piece) {
      pending += piece;
      let p = 0;
      while (p < pending.length && !(/[*s]/i.test(pending[p]) && pending[p - 1] !== '*' && holdsFrom(p))) p += 1;
      const out = pending.slice(0, p);
      pending = pending.slice(p);
      if (out) {
        const newline = out.lastIndexOf('\n');
        shownLineBlank = newline >= 0 ? blank(out.slice(newline + 1)) : shownLineBlank && blank(out);
        lastShown = out.at(-1);
      }
      return out;
    },
  };
}

/**
 * Stream from each model in turn, calling onToken(text) as safe answer text arrives. Falls back
 * like invokeWithFallback, but only while no text was sent: after the first token an error
 * ends the answer (the visitor already saw part of it). Resolves to the full model output.
 */
async function streamWithFallback(attempts, input, onToken) {
  let firstError;
  for (const [index, { name, llm }] of attempts.entries()) {
    const chain = prompt.pipe(llm).pipe(new StringOutputParser());
    const filter = createSourcesFilter();
    let output = '';
    let sent = false;
    try {
      await withTimeout(async (signal, touch) => {
        const stream = await chain.stream(input, { signal });
        for await (const piece of stream) {
          touch();
          output += piece;
          const text = filter.push(piece);
          if (text) {
            sent = true;
            onToken(text);
          }
        }
      });
      if (index > 0) console.warn(`LLM answered with fallback model ${name}.`);
      return output;
    } catch (error) {
      if (sent) throw toLlmError(error);
      firstError ??= error;
      const next = attempts[index + 1];
      if (!next || !isRetryableLlmError(error)) break;
      console.warn(`LLM fallback: ${name} failed (${describeError(error)}), trying ${next.name}.`);
    }
  }
  throw toLlmError(firstError);
}

/** Turn provider errors into short messages the user can act on. */
function toLlmError(error) {
  const status = errorStatus(error);
  const text = String(error?.message ?? '');
  console.error('LLM error:', text);
  if (error instanceof LlmTimeoutError) {
    return new HttpError(504, 'LLM_TIMEOUT', 'The AI took too long to answer. Please try again.');
  }
  if (status === 429 || /quota|rate.?limit|resource.?exhausted/i.test(text)) {
    return new HttpError(429, 'LLM_RATE_LIMIT', 'The free Gemini limit was reached. Wait a minute and try again.');
  }
  if (status === 503 || /overloaded|high demand|unavailable/i.test(text)) {
    return new HttpError(503, 'LLM_BUSY', 'Gemini is busy right now. Try again in a moment, or set GEMINI_MODEL in .env to another model.');
  }
  if (status === 401 || status === 403 || /api.?key/i.test(text)) {
    return new HttpError(502, 'LLM_AUTH', 'Gemini rejected the API key. Check GOOGLE_API_KEY in your .env file.');
  }
  if (status === 400 && /thinking/i.test(text)) {
    return new HttpError(502, 'LLM_THINKING', `The model "${config.geminiModel}" does not accept GEMINI_THINKING_BUDGET=${config.geminiThinkingBudget}. Set GEMINI_THINKING_BUDGET=default in .env.`);
  }
  if (status === 404 || /not found/i.test(text)) {
    return new HttpError(502, 'LLM_MODEL', `The model "${config.geminiModel}" is not available. Set GEMINI_MODEL in .env to a current model.`);
  }
  return new HttpError(502, 'LLM_ERROR', 'The AI service could not answer right now. Please try again.');
}

/**
 * Checks, retrieval and prompt input shared by answerQuestion and streamAnswer.
 * input is null when nothing was retrieved (the answer is then "not found").
 */
async function prepareAnswer({ question, history = [], llm, fallbackLlm, session }) {
  if (!question) {
    throw new HttpError(400, 'EMPTY_QUESTION', 'Type a question first.');
  }
  if (question.length > MAX_MESSAGE_LENGTH) {
    throw new HttpError(400, 'QUESTION_TOO_LONG', 'Your question is too long. Keep it under 2000 characters.');
  }
  if (!hasDocuments(session)) {
    throw new HttpError(400, 'NO_DOCUMENTS', `Upload a document first, then ask your question. Documents are removed after ${config.sessionTtlMinutes} minutes without activity.`);
  }
  const attempts = modelAttempts(llm, fallbackLlm);

  const chatHistory = toChatHistory(history);
  const results = await search(session, buildSearchQuery(question, chatHistory), config.topK);
  const chunks = results.map(([chunk]) => chunk);
  const input = chunks.length === 0 ? null : { context: formatContext(chunks), history: chatHistory, question };
  return { attempts, results, input };
}

/** Final answer text and its sources from the full model output. */
function finishAnswer(question, output, results) {
  const { answer: text, cited } = splitCitations(output);
  const finalAnswer = text || NOT_FOUND_ANSWER;
  // When the answer is not in the documents, there is no source to show.
  const sources = finalAnswer.includes(NOT_FOUND_ANSWER) ? [] : toSources(pickSourceChunks(results, cited), `${question}\n${finalAnswer}`);
  return { answer: finalAnswer, sources };
}

/**
 * Retrieve relevant chunks and ask the LLM to answer from them only. Tests can pass
 * `llm` (and `fallbackLlm`) instead of the configured Gemini models.
 * @param {{ question: string, history?: Array<{ role: string, content: string }>, llm?: import('@langchain/core/runnables').Runnable, fallbackLlm?: import('@langchain/core/runnables').Runnable, session: object | null }} params
 */
export async function answerQuestion(params) {
  const { attempts, results, input } = await prepareAnswer(params);
  if (!input) return { answer: NOT_FOUND_ANSWER, sources: [] };
  return finishAnswer(params.question, await invokeWithFallback(attempts, input), results);
}

/**
 * Like answerQuestion, but calls onToken(text) while the model writes the answer (the
 * SOURCES line is never sent). Resolves to the same { answer, sources } as answerQuestion.
 * Errors before the first token are the same as answerQuestion's.
 */
export async function streamAnswer({ onToken, ...params }) {
  const { attempts, results, input } = await prepareAnswer(params);
  if (!input) return { answer: NOT_FOUND_ANSWER, sources: [] };
  return finishAnswer(params.question, await streamWithFallback(attempts, input, onToken), results);
}

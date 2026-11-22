import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { StringOutputParser } from '@langchain/core/output_parsers';
import config from '../config.js';
import { search, hasDocuments } from './vectorStore.js';
import { HttpError } from '../utils/httpError.js';

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

Context:
{context}`;

const prompt = ChatPromptTemplate.fromMessages([
  ['system', SYSTEM_PROMPT],
  new MessagesPlaceholder('history'),
  ['human', '{question}'],
]);

export function createLlm() {
  if (!config.googleApiKey) {
    throw new HttpError(503, 'MISSING_API_KEY', 'The AI is not set up yet: add GOOGLE_API_KEY to the .env file and restart the server. You can get a free key at aistudio.google.com.');
  }
  return new ChatGoogleGenerativeAI({
    model: config.geminiModel,
    apiKey: config.googleApiKey,
    temperature: 0.2,
  });
}

// A chunk is shown as a source only if it is clearly related to the question.
const MIN_SOURCE_SCORE = 0.2;
const RELATIVE_SOURCE_SCORE = 0.7;

/** Short, de-duplicated list of the relevant chunks used for an answer. */
function toSources(results) {
  const best = results[0]?.[1] ?? 0;
  const threshold = Math.max(MIN_SOURCE_SCORE, best * RELATIVE_SOURCE_SCORE);
  const seen = new Set();
  return results
    .filter(([, score]) => score >= threshold)
    .map(([chunk]) => chunk)
    .filter((chunk) => {
      const key = `${chunk.metadata.docId}:${chunk.metadata.chunk}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((chunk) => {
      const text = chunk.pageContent.replace(/\s+/g, ' ').trim();
      return {
        source: chunk.metadata.source,
        page: chunk.metadata.page ?? null,
        chunk: chunk.metadata.chunk,
        excerpt: text.length > 280 ? `${text.slice(0, 280)}…` : text,
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

/**
 * Retrieve relevant chunks and ask the LLM to answer from them only.
 * @param {{ question: string, history?: Array<{ role: string, content: string }>, llm?: import('@langchain/core/language_models/chat_models').BaseChatModel }} params
 */
/** Turn provider errors into short messages the user can act on. */
function toLlmError(error) {
  const status = error?.status ?? error?.response?.status;
  const text = String(error?.message ?? '');
  console.error('LLM error:', text);
  if (status === 429 || /quota|rate.?limit|resource.?exhausted/i.test(text)) {
    return new HttpError(429, 'LLM_RATE_LIMIT', 'The free Gemini limit was reached. Wait a minute and try again.');
  }
  if (status === 401 || status === 403 || /api.?key/i.test(text)) {
    return new HttpError(502, 'LLM_AUTH', 'Gemini rejected the API key. Check GOOGLE_API_KEY in your .env file.');
  }
  if (status === 404 || /not found/i.test(text)) {
    return new HttpError(502, 'LLM_MODEL', `The model "${config.geminiModel}" is not available. Set GEMINI_MODEL in .env to a current model.`);
  }
  return new HttpError(502, 'LLM_ERROR', 'The AI service could not answer right now. Please try again.');
}

export async function answerQuestion({ question, history = [], llm }) {
  if (!question) {
    throw new HttpError(400, 'EMPTY_QUESTION', 'Type a question first.');
  }
  if (question.length > 2000) {
    throw new HttpError(400, 'QUESTION_TOO_LONG', 'Your question is too long. Keep it under 2000 characters.');
  }
  if (!hasDocuments()) {
    throw new HttpError(400, 'NO_DOCUMENTS', 'Upload a document first, then ask your question.');
  }
  const model = llm ?? createLlm();

  const chatHistory = toChatHistory(history);
  const results = await search(buildSearchQuery(question, chatHistory), config.topK);
  const chunks = results.map(([chunk]) => chunk);
  if (chunks.length === 0) {
    return { answer: NOT_FOUND_ANSWER, sources: [] };
  }

  const chain = prompt.pipe(model).pipe(new StringOutputParser());
  let answer;
  try {
    answer = await chain.invoke({
      context: formatContext(chunks),
      history: chatHistory,
      question,
    });
  } catch (error) {
    throw toLlmError(error);
  }
  answer = answer.trim() || NOT_FOUND_ANSWER;
  // When the answer is not in the documents, there is no source to show.
  const sources = answer.includes(NOT_FOUND_ANSWER) ? [] : toSources(results);
  return { answer, sources };
}

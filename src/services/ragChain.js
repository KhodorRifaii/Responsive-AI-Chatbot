import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { StringOutputParser } from '@langchain/core/output_parsers';
import config from '../config.js';
import { search } from './vectorStore.js';

export const NOT_FOUND_ANSWER = "I couldn't find that in your uploaded documents.";

const SYSTEM_PROMPT = `You are a document assistant. Answer the user's question using ONLY the context below.
The context contains excerpts from documents the user uploaded.

Rules:
- Use only facts stated in the context. Never use outside knowledge, and never guess.
- If the context does not contain the answer, reply exactly: "${NOT_FOUND_ANSWER}"
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
  return new ChatGoogleGenerativeAI({
    model: config.geminiModel,
    apiKey: config.googleApiKey,
    temperature: 0.2,
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
export async function answerQuestion({ question, history = [], llm = createLlm() }) {
  const chatHistory = toChatHistory(history);
  const chunks = await search(buildSearchQuery(question, chatHistory), config.topK);
  if (chunks.length === 0) {
    return { answer: NOT_FOUND_ANSWER };
  }

  const chain = prompt.pipe(llm).pipe(new StringOutputParser());
  const answer = await chain.invoke({
    context: formatContext(chunks),
    history: chatHistory,
    question,
  });
  return { answer: answer.trim() };
}

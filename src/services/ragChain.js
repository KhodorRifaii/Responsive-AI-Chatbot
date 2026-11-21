import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatPromptTemplate } from '@langchain/core/prompts';
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

Context:
{context}`;

const prompt = ChatPromptTemplate.fromMessages([
  ['system', SYSTEM_PROMPT],
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

/**
 * Retrieve relevant chunks and ask the LLM to answer from them only.
 * @param {{ question: string, llm?: import('@langchain/core/language_models/chat_models').BaseChatModel }} params
 */
export async function answerQuestion({ question, llm = createLlm() }) {
  const chunks = await search(question, config.topK);
  if (chunks.length === 0) {
    return { answer: NOT_FOUND_ANSWER };
  }

  const chain = prompt.pipe(llm).pipe(new StringOutputParser());
  const answer = await chain.invoke({
    context: formatContext(chunks),
    question,
  });
  return { answer: answer.trim() };
}

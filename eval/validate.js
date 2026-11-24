// Checks of the question file against the documents. Pure: the runner passes the parsed texts in and decides what
// to do with the problems (stop) and the warnings (print).
import { findCollisions, hasFact } from './score.js';

const TYPES = ['single', 'multi', 'cross-lingual', 'unanswerable'];

/**
 * @param {Array<object>} questions parsed lines of questions.jsonl
 * @param {{ docFiles: string[], parsedText: Record<string, string> }} docs file names and the text the app reads from each
 * @returns {{ problems: string[], warnings: string[] }} problems stop the run; warnings are only printed
 */
export function validateQuestions(questions, { docFiles, parsedText }) {
  const problems = [];
  const seen = new Set();
  for (const q of questions) {
    const where = q.id ?? '(no id)';
    if (!q.id || seen.has(q.id)) problems.push(`${where}: missing or duplicate id`);
    seen.add(q.id);
    if (!['en', 'ar'].includes(q.lang)) problems.push(`${where}: lang must be en or ar`);
    if (!TYPES.includes(q.type)) problems.push(`${where}: unknown type ${q.type}`);
    if (typeof q.question !== 'string' || !q.question.trim()) problems.push(`${where}: empty question`);
    if (!Array.isArray(q.sources) || !Array.isArray(q.facts)) {
      problems.push(`${where}: sources and facts must be arrays`);
      continue;
    }
    for (const s of q.sources) if (!docFiles.includes(s)) problems.push(`${where}: source ${s} is not in eval/docs`);
    if (q.type === 'unanswerable') {
      if (q.sources.length || q.facts.length) problems.push(`${where}: unanswerable questions have no sources or facts`);
      continue;
    }
    if (q.sources.length < (q.type === 'multi' ? 2 : 1)) problems.push(`${where}: too few sources for type ${q.type}`);
    if (q.facts.length === 0) problems.push(`${where}: answerable questions need at least one fact`);
    // Every gold fact must appear in its source text (catches typos in the gold set), and must NOT already be in
    // the question: an answer that only repeats the question would score a free point.
    const sourceText = q.sources.map((s) => parsedText[s] ?? '').join('\n');
    for (const alternatives of q.facts) {
      if (!Array.isArray(alternatives) || alternatives.length === 0) {
        problems.push(`${where}: a fact needs a list of alternatives`);
        continue;
      }
      if (!hasFact(sourceText, alternatives)) problems.push(`${where}: no alternative of ${JSON.stringify(alternatives)} is found in its sources`);
      for (const alternative of alternatives) {
        if (hasFact(q.question, [alternative])) problems.push(`${where}: "${alternative}" is already in the question text, so repeating the question would score it`);
      }
    }
    // `shared` lists gold alternatives that also appear in a document that is not an expected source, each with the
    // reason it cannot be avoided. An entry without a reason, or one that is no longer a collision, is a mistake.
    if (q.shared !== undefined) {
      if (typeof q.shared !== 'object' || q.shared === null || Array.isArray(q.shared)) {
        problems.push(`${where}: shared must be an object { alternative: reason }`);
      } else {
        const actual = new Set(findCollisions({ ...q, shared: undefined }, parsedText).map((c) => c.alternative));
        const gold = new Set(q.facts.flat());
        for (const [alternative, reason] of Object.entries(q.shared)) {
          if (typeof reason !== 'string' || !reason.trim()) problems.push(`${where}: shared "${alternative}" needs a reason`);
          if (!gold.has(alternative)) problems.push(`${where}: shared "${alternative}" is not one of the gold alternatives`);
          else if (!actual.has(alternative)) problems.push(`${where}: shared "${alternative}" no longer appears in another document; remove it`);
        }
      }
    }
  }
  // Warn (not fail) when a gold alternative also appears in a document that is not an expected source and is not listed in shared.
  const warnings = questions.flatMap((q) => (Array.isArray(q.sources) && Array.isArray(q.facts) ? findCollisions(q, parsedText).map((c) => `${q.id}: "${c.alternative}" also appears in ${c.file}`) : []));
  return { problems, warnings };
}

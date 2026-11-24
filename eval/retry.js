// Guard for --retry-errors: a retry may only complete the same run (same models, settings, questions and
// documents), or the results file would mix two different runs.
const SETTINGS = ['mainModel', 'fallbackModel', 'thinking', 'fakeLlm', 'embeddingModel', 'embeddingDtype', 'chunkSize', 'chunkOverlap', 'topK', 'mode'];

/**
 * Reasons why a previous results file cannot be completed by this run (empty list = fine).
 * A file that stopped half way is fine: ids that are missing from it are asked again.
 * @param {{ meta?: object, results?: Array<{ id: string }> }} previous
 * @param {{ settings: object, fingerprint: string, questionIds: string[] }} current
 */
export function retryProblems(previous, current) {
  const problems = SETTINGS.filter((key) => JSON.stringify(previous.meta?.[key]) !== JSON.stringify(current.settings[key])).map((key) => `${key} differs`);
  if (previous.meta?.datasetFingerprint !== current.fingerprint) problems.push('questions or documents differ');
  const priorIds = (previous.results ?? []).map((r) => r.id);
  const known = new Set(current.questionIds);
  const unknown = priorIds.filter((id) => !known.has(id));
  if (unknown.length) problems.push(`ids not in the question file: ${unknown.join(', ')}`);
  const twice = priorIds.filter((id, i) => priorIds.indexOf(id) !== i);
  if (twice.length) problems.push(`ids listed twice: ${[...new Set(twice)].join(', ')}`);
  return problems;
}

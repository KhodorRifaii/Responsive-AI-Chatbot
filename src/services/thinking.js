// Which "thinking" setting each Gemini model accepts. Sending the wrong one is a 400 from the API
// ("Request contains an invalid argument."): gemini-3.5-flash-lite rejects thinkingBudget, which
// made the fallback model unusable. Source: https://aistudio.google.com/docs/thinking
const LEVELS = ['minimal', 'low', 'medium', 'high'];

// Gemini 3 models take a thinking level, and not every model takes every level. Only models listed
// both in the docs table and on the live model list are here; any other model gets no setting.
const ALLOWED_LEVELS = {
  'gemini-3.8-flash': ['low', 'medium', 'high'],
  'gemini-3.6-flash': LEVELS,
  'gemini-3.5-flash-lite': LEVELS,
  'gemini-3.1-flash-lite': LEVELS,
  'gemini-3-flash-preview': LEVELS,
  'gemini-3.1-pro-preview': ['low', 'medium', 'high'],
};

/**
 * The `thinkingConfig` to send to one model, or undefined to leave it to the model.
 * - Gemini 2.5 models: a token budget (`budget`, null = the model's own setting).
 * - Gemini 3 models in ALLOWED_LEVELS: a thinking level (`level`, null = the model's own setting).
 *   A level the model does not accept becomes the nearest one it does (minimal -> low).
 * - Anything else (newer or unknown models, -latest aliases): nothing, because a setting we have
 *   not verified for that model could be rejected.
 * @param {string} model
 * @param {{ level: string | null, budget: number | null }} settings
 */
export function thinkingConfigFor(model, { level, budget }) {
  if (/^gemini-2\.5-/.test(model)) return budget === null ? undefined : { thinkingBudget: budget };
  const allowed = ALLOWED_LEVELS[model];
  if (!allowed || level === null) return undefined;
  if (allowed.includes(level)) return { thinkingLevel: level };
  // Highest accepted level at or below the request, otherwise the lowest accepted one.
  const below = allowed.filter((l) => LEVELS.indexOf(l) <= LEVELS.indexOf(level));
  return { thinkingLevel: below.at(-1) ?? allowed[0] };
}

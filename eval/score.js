// Deterministic scoring for the eval. Pure functions: no config, no network, nothing from src/.
// Matching policy (documented in the README): text is normalised, split into tokens, and a gold
// alternative must appear as a run of whole tokens in the answer. No raw substring matching.

const UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
// Arabic hours as ordinal words ("الساعة التاسعة"), written the way normalize() spells them.
const ARABIC_HOURS = [['الحاديه عشره', 11], ['الثانيه عشره', 12], ['الاولي', 1], ['الثانيه', 2], ['الثالثه', 3], ['الرابعه', 4], ['الخامسه', 5], ['السادسه', 6], ['السابعه', 7], ['الثامنه', 8], ['التاسعه', 9], ['العاشره', 10]];

/**
 * Lowercase and unify spellings so that equal facts compare equal: curly quotes, markdown
 * emphasis, Arabic letters/digits, thousands separators (comma, dot, space), "9:00 p.m." as "9 pm",
 * "$40" as "40 dollars", English number words ("twenty-four", "twelve") and Arabic hour words.
 */
export function normalize(text) {
  let out = String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[*`]/g, '')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '') // Arabic diacritics and tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
  out = out
    .replace(/(?<=\d)[,٬،](?=\d{3}(?!\d))/g, '')
    // 45.000 (dot groups, not an address like 192.168.8.1) and 45 000 (space groups)
    .replace(/(?<![\d.])\d{1,3}(?:\.\d{3})+(?!\d|\.\d)/g, (m) => m.replaceAll('.', ''))
    .replace(/(?<![\d.,])\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?!\d)/g, (m) => m.replace(/[ \u00a0\u202f]/g, ''))
    .replace(/(?:us\s?)?\$\s?(\d+(?:\.\d+)?)/g, '$1 dollars')
    .replace(/\b([ap])\.\s?m\b\.?/g, '$1m')
    .replace(/(\d{1,2})\.(\d{2})(?=\s?[ap]m\b)/g, '$1:$2')
    .replace(/\b(\d{1,2}):00(?=\s?[ap]m\b)/g, '$1')
    .replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[ -](one|two|three|four|five|six|seven|eight|nine)\b/g, (_, t, u) => String(TENS[t] + UNITS[u]))
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\b/g, (w) => String(UNITS[w]))
    .replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/g, (w) => String(TENS[w]));
  for (const [word, hour] of ARABIC_HOURS) out = out.replaceAll(`الساعه ${word}`, `الساعه ${hour}`);
  return out;
}

/** Numbers (with an optional decimal part) and runs of letters. "ب30" gives "ب", "30"; "10:00" gives "10", "00". */
export function tokens(text) {
  return normalize(text).match(/\d+(?:\.\d+)?|\p{L}+/gu) ?? [];
}

// Attached Arabic articles, prepositions and conjunctions that may precede a gold word in an answer.
const PREFIXES = new Set(['و', 'ف', 'ب', 'ل', 'ك', 'س', 'ال', 'وال', 'فال', 'بال', 'كال', 'لل', 'ولل']);
const ARABIC = /^[؀-ۿ]+$/;

/**
 * Does an answer token match a gold token? Equal, or (Arabic gold words of 3+ letters only) equal to
 * one of the closed-list prefixes followed by the gold word. Nothing is ever stripped from the answer
 * token on its own, so an answer containing only "تاب" never satisfies the gold word "كتاب".
 */
function tokenMatches(answerToken, goldToken) {
  if (answerToken === goldToken) return true;
  if (!ARABIC.test(goldToken) || goldToken.length < 3 || answerToken.length <= goldToken.length) return false;
  return answerToken.endsWith(goldToken) && PREFIXES.has(answerToken.slice(0, answerToken.length - goldToken.length));
}

// A fact right after one of these words is negated ("not 24 working days"), so it does not count.
// "t" is what is left of n't after tokenising ("doesn't" gives "doesn", "t").
const NEGATORS = new Set(['not', 'no', 'never', 'neither', 'nor', 't', 'لا', 'ليس', 'ليست', 'لم', 'لن', 'غير']);

/** True when any alternative appears as a consecutive run of tokens in the text, not negated. */
export function hasFact(text, alternatives) {
  const words = tokens(text);
  return alternatives.some((alternative) => {
    const gold = tokens(alternative);
    if (gold.length === 0) return false;
    for (let start = 0; start + gold.length <= words.length; start += 1) {
      if (!gold.every((g, i) => tokenMatches(words[start + i], g))) continue;
      const negated = [words[start - 1], words[start - 2]].some((w) => w !== undefined && NEGATORS.has(w));
      if (!negated) return true;
    }
    return false;
  });
}

/**
 * Gold alternatives that also appear in a document that is NOT an expected source: an answer taken from
 * that document could pass. Alternatives listed in question.shared are known and accepted.
 * docText: { file: text }.
 */
export function findCollisions(question, docText) {
  const found = [];
  for (const alternatives of question.facts) {
    for (const alternative of alternatives) {
      if (question.shared?.includes(alternative)) continue;
      for (const [file, text] of Object.entries(docText)) {
        if (!question.sources.includes(file) && hasFact(text, [alternative])) found.push({ alternative, file });
      }
    }
  }
  return found;
}

// "Not found" phrases in English and Arabic (after normalize), to see refusals that are not the app's exact sentence.
const SOFT_REFUSAL = new RegExp([
  "couldn[’']?t find|could not find|can[’']?t find|cannot find",
  'not (?:found|mentioned|stated|provided|specified|available|included)',
  'no (?:information|mention|details)',
  "(?:does not|doesn[’']?t|do not|don[’']?t) (?:mention|say|state|contain|specify|provide|know|have)",
  "(?:isn[’']?t|is not) (?:mentioned|stated|specified)",
  'لم (?:اجد|يرد|يذكر|اعثر|تذكر|ترد)',
  'لا (?:يوجد|توجد|تتوفر|يتوفر|اعرف|يذكر|تذكر|تحتوي|تتضمن|اجد)',
  'غير (?:موجود|مذكور|متوفر|متاح|وارد)',
].join('|'));

/** The app's own refusal: the answer is exactly the "not found" sentence (nothing before or after it). */
export const isRefusal = (answer, notFoundAnswer) => normalize(answer) === normalize(notFoundAnswer);
export const isSoftRefusal = (answer) => SOFT_REFUSAL.test(normalize(answer));

const choose = (n, k) => {
  if (k < 0 || k > n) return 0;
  let value = 1;
  for (let i = 1; i <= k; i += 1) value = (value * (n - k + i)) / i;
  return value;
};

/**
 * Chance that k chunks drawn at random (no repeats) from all chunks include at least one chunk of EACH
 * expected file. chunksByFile: { file: chunkCount }. Inclusion-exclusion over the files that are missed.
 */
export function chanceHitAll(expectedFiles, chunksByFile, k) {
  const total = Object.values(chunksByFile).reduce((a, b) => a + b, 0);
  const sizes = expectedFiles.map((f) => chunksByFile[f] ?? 0);
  let probability = 0;
  for (let mask = 0; mask < 1 << sizes.length; mask += 1) {
    let missed = 0;
    let bits = 0;
    sizes.forEach((size, i) => {
      if (mask & (1 << i)) {
        missed += size;
        bits += 1;
      }
    });
    probability += (bits % 2 ? -1 : 1) * (choose(total - missed, k) / choose(total, k));
  }
  return probability;
}

const unique = (list) => [...new Set(list)];

/**
 * Score one question. run = { retrieved: [{ source, score }], answer, sources: [{ source }], error }.
 * Answerable questions get retrieval, citation and answer scores; unanswerable ones a refusal score.
 * A run with an error has no answer scores (it is reported as errored, not as wrong); a run with no
 * answer at all (retrieval-only) gets the retrieval fields only.
 */
export function scoreQuestion(question, run, notFoundAnswer) {
  const answerable = question.sources.length > 0;
  const files = unique((run.retrieved ?? []).map((r) => r.source));
  const record = { id: question.id, answerable, topScore: run.retrieved?.[0]?.score ?? null };
  if (answerable) {
    record.retrievalAll = question.sources.every((s) => files.includes(s));
    record.retrievalAny = question.sources.some((s) => files.includes(s));
    record.retrievalTop1 = question.sources.includes(run.retrieved?.[0]?.source);
    record.chance = run.chance ?? null;
    record.chanceTop1 = run.chanceTop1 ?? null;
  }
  if (run.error) return { ...record, errored: true };
  // No answer was asked for (retrieval-only run): only retrieval fields, never fake answer scores.
  if (run.answer === undefined) return { ...record, noAnswer: true };
  const cited = unique((run.sources ?? []).map((s) => s.source));
  record.refused = isRefusal(run.answer, notFoundAnswer);
  // Loose flag: any "not found" wording, including the exact sentence inside a longer answer.
  record.softRefused = record.refused || isSoftRefusal(run.answer) || normalize(run.answer).includes(normalize(notFoundAnswer));
  if (answerable) {
    record.citedAll = question.sources.every((s) => cited.includes(s));
    record.factsFound = question.facts.map((alternatives) => hasFact(run.answer, alternatives));
    record.factRecall = record.factsFound.filter(Boolean).length / question.facts.length;
    record.correct = !record.refused && record.factsFound.every(Boolean);
    // Stricter: also showed every expected source, so the facts came from the right documents.
    record.correctAndCited = record.correct && record.citedAll;
  } else {
    // A correct refusal: the app's exact sentence and no source shown.
    record.refusedCorrectly = record.refused && cited.length === 0;
  }
  return record;
}

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const share = (records, predicate) => (records.length ? records.filter(predicate).length / records.length : null);

/** One table row for a group of scored records (and their questions' types/languages). */
export function summarizeGroup(records) {
  const answerable = records.filter((r) => r.answerable);
  const answered = answerable.filter((r) => !r.errored && !r.noAnswer);
  const unanswerable = records.filter((r) => !r.answerable);
  const answeredNone = unanswerable.filter((r) => !r.errored && !r.noAnswer);
  return {
    answerable: answerable.length,
    unanswerable: unanswerable.length,
    errored: records.filter((r) => r.errored).length,
    retrievalAll: share(answerable, (r) => r.retrievalAll),
    retrievalAny: share(answerable, (r) => r.retrievalAny),
    retrievalTop1: share(answerable, (r) => r.retrievalTop1),
    chance: mean(answerable.map((r) => r.chance).filter((c) => c !== null)),
    chanceTop1: mean(answerable.map((r) => r.chanceTop1).filter((c) => c !== null)),
    citedAll: share(answered, (r) => r.citedAll),
    correct: share(answered, (r) => r.correct),
    correctAndCited: share(answered, (r) => r.correctAndCited),
    factRecall: mean(answered.map((r) => r.factRecall)),
    falseRefusals: answered.filter((r) => r.refused).length,
    answeredCount: answered.length,
    refused: share(answeredNone, (r) => r.refusedCorrectly),
    softRefused: share(answeredNone, (r) => r.softRefused),
    unansweredCount: answeredNone.length,
    topScoreAnswerable: mean(answerable.map((r) => r.topScore).filter((s) => s !== null)),
    topScoreUnanswerable: mean(unanswerable.map((r) => r.topScore).filter((s) => s !== null)),
  };
}

/** Summaries for the slices shown in the README: all, by language, by question type. */
export function summarize(questions, records) {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const slices = {
    all: () => true,
    en: (q) => q.lang === 'en',
    ar: (q) => q.lang === 'ar',
    single: (q) => q.type === 'single',
    'cross-lingual': (q) => q.type === 'cross-lingual',
    multi: (q) => q.type === 'multi',
    unanswerable: (q) => q.type === 'unanswerable',
  };
  return Object.fromEntries(Object.entries(slices).map(([name, keep]) => [name, summarizeGroup(records.filter((r) => keep(byId.get(r.id))))]));
}

/** Latency stats in ms (mean, median, max) over the given numbers. */
export function latencyStats(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { mean: mean(values), median, max: sorted.at(-1) };
}

/**
 * What the app logged while answering one question (console.warn / console.error lines): every line kept
 * (cut to 300 characters), the models that failed, whether the fallback model answered, and which model did.
 */
export function analyzeLogs(logs, mainModel = null) {
  const failedModels = [...new Set(logs.map((l) => /^LLM fallback(?: model)?:? (\S+) failed/.exec(l)?.[1]).filter(Boolean))];
  return {
    logs: logs.map((l) => l.slice(0, 300)),
    failedModels,
    mainFailed: failedModels.length > 0,
    fallbackUsed: logs.some((l) => l.startsWith('LLM answered with fallback model')),
    // The model that wrote the answer: the fallback named in the log line, otherwise the main model.
    answeredBy: logs.map((l) => /^LLM answered with fallback model (\S+?)\.?$/.exec(l)?.[1]).find(Boolean) ?? mainModel,
  };
}

/** 95% Wilson score interval for k successes out of n, as [low, high] shares; null when n is 0. */
export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

/**
 * Build a single OpenAI-compatible chat request for every ranked candidate.
 * The model is forced to return JSON and to reuse the provided source URLs.
 * has_llm_key is false when OPENAI_API_KEY is unset, which skips the HTTP node.
 */
const payload = $input.first().json;
function readEnv(name, fallback) {
  try {
    const bag = (typeof $env !== 'undefined') ? $env : {};
    const value = bag[name];
    if (value == null || value === '') return fallback == null ? '' : fallback;
    return String(value);
  } catch {
    return fallback == null ? '' : fallback;
  }
}

const apiKey = readEnv('OPENAI_API_KEY', '').trim();
const model = readEnv('OPENAI_MODEL', 'gpt-4o-mini').trim() || 'gpt-4o-mini';
const baseUrl = readEnv('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, '');

const SYSTEM = [
  'You extract verifiable facts from official AI announcements and propose one post angle per article.',
  'Return a JSON object of the form {"ideas":[...]} and nothing else.',
  'Each idea MUST use this shape:',
  '{"title":string,"source_url":string,"source_name":string,"published":string,"facts":string[],"post_angle":string,"confidence":"high"|"medium"|"low"}',
  'Rules:',
  '- Copy source_url exactly as provided. Do not invent, shorten, or replace it.',
  '- Facts must be supported by the provided source text. Prefer close paraphrase over flourish.',
  '- Never invent figures, dates, names, product versions, or quotes.',
  '- If a number does not appear in the source text, do not use it.',
  '- If the source is thin, write fewer facts and set confidence to low.',
  '- post_angle is one sharp editorial angle, not a summary and not a published post.',
  '- Do not mention any agent, assistant, or tool by a personal name.',
].join('\n');

const articles = (payload.candidates || []).map((item) => ({
  title: item.title,
  source_url: item.url,
  source_name: item.source_name,
  published: item.published,
  source_text: String(item.content || '').slice(0, 4000),
  score: item.score,
  matched_keywords: item.matched_keywords,
}));

const llmRequest = {
  model,
  temperature: 0,
  response_format: { type: 'json_object' },
  messages: [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `Extract facts and propose post angles for these ${articles.length} articles:\n${JSON.stringify({ articles }, null, 2)}`,
    },
  ],
};

return [{
  json: {
    ...payload,
    has_llm_key: apiKey.length > 0,
    llm_model: model,
    llm_url: `${baseUrl}/chat/completions`,
    llm_request: llmRequest,
  },
}];

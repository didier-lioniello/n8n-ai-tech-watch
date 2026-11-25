/**
 * If the LLM returned valid JSON ideas, use them. Otherwise build a
 * conservative digest from the source titles and snippets only.
 * Facts in the fallback path are copied from the source text, never invented.
 *
 * After the HTTP node, n8n replaces the item with the API response, so this
 * node also re-reads the prepared payload from "Code · Prepare LLM request".
 */
function firstSentences(text, max = 3) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const parts = clean.split(/(?<=[.?!])\s+/).map((s) => s.trim()).filter((s) => s.length > 20);
  const unique = [];
  const seen = new Set();
  for (const part of parts) {
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(part.length > 400 ? `${part.slice(0, 397)}...` : part);
    if (unique.length >= max) break;
  }
  return unique;
}

function fallbackIdeas(candidates) {
  return (candidates || []).map((item) => {
    const facts = firstSentences(item.content);
    if (facts.length === 0 && item.title) {
      facts.push(`Official title: ${item.title}`);
    }
    return {
      title: item.title,
      source_url: item.url,
      source_name: item.source_name,
      published: item.published,
      facts,
      post_angle: 'Needs human review — the LLM path was skipped or failed. Draft an angle only from the facts below.',
      confidence: 'low',
      llm_used: false,
      needs_review: true,
      score: item.score,
      matched_keywords: item.matched_keywords || [],
    };
  });
}

function pickCompletion(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  if (raw.choices && raw.choices[0]) return raw.choices[0];
  if (raw.body) {
    const body = typeof raw.body === 'string' ? safeJson(raw.body) : raw.body;
    return pickCompletion(body);
  }
  return raw;
}

function safeJson(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text;
  const str = String(text).trim();
  try { return JSON.parse(str); } catch { /* continue */ }
  const start = str.indexOf('{');
  const end = str.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(str.slice(start, end + 1)); } catch { return null; }
  }
  return null;
}

function ideasFromLlm(raw) {
  const choice = pickCompletion(raw);
  if (!choice) return null;
  const content = choice.message?.content || choice.content || choice;
  const parsed = safeJson(content);
  if (!parsed) return null;
  const list = Array.isArray(parsed.ideas) ? parsed.ideas : (Array.isArray(parsed) ? parsed : null);
  if (!list) return null;
  return list.map((idea) => ({
    title: idea.title || '',
    source_url: idea.source_url || idea.url || '',
    source_name: idea.source_name || '',
    published: idea.published || '',
    facts: Array.isArray(idea.facts) ? idea.facts.map((f) => String(f)) : [],
    post_angle: idea.post_angle || idea.angle || '',
    confidence: idea.confidence || 'medium',
    llm_used: true,
    needs_review: true,
  }));
}

const incoming = $input.first().json;
let prepared = incoming;
try {
  if (typeof $ === 'function') {
    const fromPrep = $('Code · Prepare LLM request').first().json;
    if (fromPrep && Array.isArray(fromPrep.candidates)) prepared = fromPrep;
  }
} catch { /* running outside n8n, or the skip-LLM path already has candidates */ }

if (!Array.isArray(prepared.candidates) && Array.isArray(incoming.candidates)) {
  prepared = incoming;
}

const httpLooksFailed = Boolean(incoming.error)
  || (incoming.statusCode && Number(incoming.statusCode) >= 400);
let llmError = null;
if (httpLooksFailed) {
  llmError = incoming.error?.message || incoming.error || incoming.message || `HTTP ${incoming.statusCode}`;
}

let ideas = null;
let llmUsed = false;
const shouldTryLlm = Boolean(prepared.has_llm_key) && (incoming !== prepared || incoming.choices || incoming.body);
if (shouldTryLlm && !httpLooksFailed) {
  try {
    ideas = ideasFromLlm(incoming);
    if (ideas && ideas.length) llmUsed = true;
    else llmError = llmError || 'LLM response did not contain a usable ideas array';
  } catch (err) {
    llmError = err.message || String(err);
  }
}

if (!llmUsed) {
  ideas = fallbackIdeas(prepared.candidates || []);
}

return [{
  json: {
    generated_at: prepared.generated_at,
    timezone: prepared.timezone || 'Europe/Paris',
    lookback_hours: prepared.lookback_hours,
    cutoff_iso: prepared.cutoff_iso,
    feed_health: prepared.feed_health,
    stats: prepared.stats,
    ranking: prepared.ranking,
    candidates: prepared.candidates,
    has_llm_key: Boolean(prepared.has_llm_key),
    llm_model: prepared.llm_model || null,
    llm_used: llmUsed,
    llm_error: llmError ? String(llmError) : null,
    ideas,
  },
}];

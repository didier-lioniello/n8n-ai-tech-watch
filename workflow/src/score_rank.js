/**
 * Keyword-score every item in the 48h window, always keep official blog
 * posts, and only promote the highest-scoring arXiv papers up to a cap.
 */
const MAX_OFFICIAL = 20;
const MAX_ARXIV = 5;
const MAX_TOTAL = 16;
const MIN_ARXIV_SCORE = 3;

const KEYWORDS = [
  { label: 'openai', weight: 5, re: /\b(gpt-?\d|chatgpt|openai)\b/i },
  { label: 'anthropic', weight: 5, re: /\b(claude|anthropic)\b/i },
  { label: 'google', weight: 5, re: /\b(gemini|deepmind|antigravity|genie)\b/i },
  { label: 'huggingface', weight: 3, re: /\b(hugging\s?face|transformers|huggingface)\b/i },
  { label: 'markets', weight: 4, re: /\b(ipo|offering|nasdaq|placement)\b/i },
  { label: 'agents', weight: 3, re: /\b(agent|agents|agentic|multi-agent)\b/i },
  { label: 'eval', weight: 3, re: /\b(benchmark|eval(?:uation)?|leaderboard|swe-bench)\b/i },
  { label: 'safety', weight: 3, re: /\b(safety|alignment|safeguard|governance)\b/i },
  { label: 'release', weight: 2, re: /\b(release|launches|introducing|available now|is now available)\b/i },
  { label: 'research', weight: 2, re: /\b(research|paper|preprint|arxiv)\b/i },
  { label: 'model', weight: 1, re: /\b(api|model|llm|reasoning|multimodal)\b/i },
];

const payload = $input.first().json;
const items = Array.isArray(payload.items) ? payload.items : [];

function scoreItem(item) {
  const text = `${item.title || ''}\n${item.content || ''}`;
  const matched = [];
  let score = 0;
  for (const keyword of KEYWORDS) {
    if (keyword.re.test(text)) {
      score += keyword.weight;
      matched.push(keyword.label);
    }
  }
  const isArxiv = String(item.source_name || '').toLowerCase().includes('arxiv');
  if (!isArxiv) score += 2; // slight official-blog prior
  return { ...item, score, matched_keywords: matched, is_arxiv: isArxiv };
}

const scored = items.map(scoreItem);
const official = scored
  .filter((item) => !item.is_arxiv)
  .sort((a, b) => b.score - a.score || String(b.published).localeCompare(String(a.published)))
  .slice(0, MAX_OFFICIAL);
const arxiv = scored
  .filter((item) => item.is_arxiv && item.score >= MIN_ARXIV_SCORE)
  .sort((a, b) => b.score - a.score || String(b.published).localeCompare(String(a.published)))
  .slice(0, MAX_ARXIV);

// Official posts in the window come first, then the best arXiv papers, up to MAX_TOTAL.
const arxivSlots = Math.max(0, MAX_TOTAL - official.length);
const combined = [...official, ...arxiv.slice(0, arxivSlots)];

return [{
  json: {
    ...payload,
    items: scored,
    candidates: combined,
    ranking: {
      official_kept: official.length,
      arxiv_kept: arxiv.length,
      candidates: combined.length,
      min_arxiv_score: MIN_ARXIV_SCORE,
      max_total: MAX_TOTAL,
    },
  },
}];

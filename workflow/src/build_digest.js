/**
 * Assemble a Markdown digest for human review. Every idea stays in
 * "needs review" — this workflow never publishes.
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


function formatParis(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} Europe/Paris`;
}

function bullet(items) {
  if (!items || !items.length) return '- _None._';
  return items.map((x) => `- ${x}`).join('\n');
}

const generatedAt = payload.generated_at || new Date().toISOString();
const llmStatus = payload.llm_used
  ? `used (${payload.llm_model || 'model set in OPENAI_MODEL'})`
  : (payload.has_llm_key ? 'failed, fallback used' : 'skipped (no OPENAI_API_KEY)');

const healthLines = (payload.feed_health || []).map((feed) => {
  const name = feed.error
    ? `${feed.source_name} (${String(feed.error).replace(/\s+/g, ' ').slice(0, 120)})`
    : feed.source_name;
  return `| ${name} | ${feed.status} | ${feed.item_count} | ${feed.feed_url} |`;
});

function ideaBlock(idea, index) {
  const facts = (idea.facts || []).map((f) => `- ${f}`).join('\n') || '- _No extractable fact in the source snippet._';
  const keywords = (idea.matched_keywords || []).join(', ') || '—';
  const reasons = (idea.rejection_reasons || []).length
    ? `\n**Rejected because:** ${(idea.rejection_reasons || []).join('; ')}`
    : '';
  return [
    `### ${index}. ${idea.title}`,
    '',
    `- **Source:** [${idea.source_name || 'source'}](${idea.source_url})`,
    `- **Published:** ${formatParis(idea.published)}`,
    `- **Score:** ${idea.score ?? '—'} (${keywords})`,
    `- **Confidence:** ${idea.confidence || '—'}`,
    `- **LLM used:** ${idea.llm_used ? 'yes' : 'no'}`,
    `- **Status:** needs review${idea.validation === 'rejected' ? ' — rejected by validation' : ''}`,
    '',
    '**Facts (must come from the source):**',
    facts,
    '',
    `**Proposed angle:** ${idea.post_angle || '_None._'}`,
    reasons,
  ].join('\n');
}

const accepted = payload.accepted || payload.ideas || [];
const rejected = payload.rejected || [];
const stats = payload.stats || {};
const ranking = payload.ranking || {};

const lines = [
  '# AI Tech Watch — digest for human review',
  '',
  `Generated: **${formatParis(generatedAt)}**`,
  `Lookback window: **${payload.lookback_hours || 48} hours** (cutoff ${formatParis(payload.cutoff_iso)})`,
  `LLM: **${llmStatus}**`,
  payload.llm_error ? `LLM error: ${payload.llm_error}` : null,
  '',
  '> Nothing in this digest is published automatically. Every item is flagged `needs_review`.',
  '> Do not add figures that are not in the linked source. A human decides what, if anything, goes out.',
  '',
  '## Run statistics',
  '',
  `| Metric | Value |`,
  `| --- | ---: |`,
  `| Incoming feed items | ${stats.incoming ?? '—'} |`,
  `| Kept in the ${payload.lookback_hours || 48}h window (deduped) | ${stats.kept ?? '—'} |`,
  `| Dropped outside window | ${stats.dropped_outside_window ?? '—'} |`,
  `| Dropped duplicates | ${stats.dropped_duplicate ?? '—'} |`,
  `| Official posts kept | ${ranking.official_kept ?? '—'} |`,
  `| arXiv papers kept | ${ranking.arxiv_kept ?? '—'} |`,
  `| Candidates sent to LLM / fallback | ${ranking.candidates ?? accepted.length} |`,
  `| Ideas accepted by validation | ${(payload.validation_stats && payload.validation_stats.accepted) ?? accepted.length} |`,
  `| Ideas rejected by validation | ${(payload.validation_stats && payload.validation_stats.rejected) ?? rejected.length} |`,
  '',
  '## Feed health',
  '',
  '| Source | Status | Items in window | Feed URL |',
  '| --- | --- | ---: | --- |',
  ...(healthLines.length ? healthLines : ['| — | — | — | — |']),
  '',
  `## Ideas accepted for review (${accepted.length})`,
  '',
  accepted.length
    ? accepted.map((idea, i) => ideaBlock(idea, i + 1)).join('\n\n')
    : '_No idea passed validation in this run._',
  '',
  `## Rejected by validation (${rejected.length})`,
  '',
  rejected.length
    ? rejected.map((idea, i) => ideaBlock(idea, i + 1)).join('\n\n')
    : '_No idea was rejected._',
  '',
  '## What to do next',
  '',
  bullet([
    'Read each source URL before you reuse a fact.',
    'Rewrite the angle in your own voice if you decide to publish.',
    'Leave rejected ideas out, or fix them against the source and re-run.',
    'Optional Slack, Gmail and Sheets nodes stay off unless `ENABLE_NOTIFICATIONS=true` and credentials are set.',
  ]),
].filter((line) => line !== null);

const markdown = lines.join('\n') + '\n';

return [{
  json: {
    generated_at: generatedAt,
    timezone: 'Europe/Paris',
    lookback_hours: payload.lookback_hours,
    llm_used: payload.llm_used,
    has_llm_key: payload.has_llm_key,
    llm_error: payload.llm_error,
    needs_review: true,
    feed_health: payload.feed_health,
    stats: payload.stats,
    ranking: payload.ranking,
    validation_stats: payload.validation_stats,
    accepted_count: accepted.length,
    rejected_count: rejected.length,
    accepted,
    rejected,
    markdown,
    digest_filename: `ai-tech-watch-${formatParis(generatedAt).slice(0, 10)}.md`,
    digest_path: readEnv('DIGEST_PATH', '/tmp/ai-tech-watch-digest.md'),
    notifications_enabled: readEnv('ENABLE_NOTIFICATIONS', 'false') === 'true',
  },
}];

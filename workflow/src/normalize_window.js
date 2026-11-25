/**
 * Merge every feed item, tag the source, drop unusable rows, dedupe by
 * canonical URL, and keep only items published in the lookback window
 * (default: 48 hours). Failures on a single feed are recorded, not fatal.
 */
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

const LOOKBACK_HOURS = Number(readEnv('LOOKBACK_HOURS', '48')) || 48;
const cutoffMs = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;

const EXPECTED_FEEDS = [
  { source_name: 'OpenAI News', feed_url: 'https://openai.com/news/rss.xml', hostIncludes: ['openai.com'] },
  { source_name: 'Google DeepMind', feed_url: 'https://www.deepmind.com/blog/rss.xml', hostIncludes: ['deepmind.google', 'deepmind.com'] },
  { source_name: 'Google AI Blog', feed_url: 'https://blog.google/technology/ai/rss/', hostIncludes: ['blog.google'] },
  { source_name: 'Hugging Face Blog', feed_url: 'https://huggingface.co/blog/feed.xml', hostIncludes: ['huggingface.co'] },
  { source_name: 'arXiv cs.AI', feed_url: 'https://rss.arxiv.org/rss/cs.AI', hostIncludes: ['arxiv.org'] },
];

function stripHtml(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonUrl(raw) {
  if (!raw) return '';
  try {
    const url = new URL(String(raw).trim());
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_') || key === 'fbclid' || key === 'ref') {
        url.searchParams.delete(key);
      }
    }
    let href = url.toString();
    if (href.endsWith('/') && url.pathname !== '/') href = href.slice(0, -1);
    url.protocol = 'https:';
    href = url.toString();
    if (href.endsWith('/') && url.pathname !== '/') href = href.slice(0, -1);
    return href;
  } catch {
    return String(raw).trim();
  }
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function inferSource(item) {
  if (item.source_name) return { source_name: item.source_name, feed_url: item.feed_url || '' };
  const url = String(item.link || item.guid || item.id || item.feed_url || '');
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
  const match = EXPECTED_FEEDS.find((feed) => feed.hostIncludes.some((h) => host.includes(h)));
  if (match) return match;
  return { source_name: host || 'Unknown source', feed_url: item.feed_url || '' };
}

function extractItem(raw) {
  const title = stripHtml(raw.title || '');
  const url = canonUrl(raw.link || raw.guid || raw.id || '');
  const published = parseDate(raw.isoDate || raw.pubDate || raw.updated || raw.published || raw.date);
  const chunks = [];
  for (const rawChunk of [raw.contentSnippet, raw.content, raw.summary, raw.description, raw['content:encoded']]) {
    const chunk = stripHtml(rawChunk);
    if (!chunk) continue;
    if (chunks.some((existing) => existing === chunk || existing.includes(chunk))) continue;
    // If the new chunk is a longer version of an earlier one, replace it.
    const idx = chunks.findIndex((existing) => chunk.includes(existing));
    if (idx >= 0) chunks[idx] = chunk;
    else chunks.push(chunk);
  }
  const content = chunks.join(' ').slice(0, 8000);
  return { title, url, published, content };
}

const feedHealthMap = new Map(EXPECTED_FEEDS.map((f) => [f.source_name, {
  source_name: f.source_name,
  feed_url: f.feed_url,
  status: 'no_items',
  item_count: 0,
  error: null,
}]));

const incoming = $input.all().map((row) => row.json);
const kept = [];
const seen = new Set();
let droppedNoUrlOrTitle = 0;
let droppedOutsideWindow = 0;
let droppedDuplicate = 0;
let droppedUndated = 0;

for (const raw of incoming) {
  const inferred = inferSource(raw);
  const health = feedHealthMap.get(inferred.source_name) || {
    source_name: inferred.source_name,
    feed_url: inferred.feed_url,
    status: 'ok',
    item_count: 0,
    error: null,
  };

  const looksLikeError = Boolean(raw.error) || Boolean(raw.message && !raw.title && !raw.link);
  if (looksLikeError) {
    health.status = 'error';
    health.error = stripHtml(raw.error?.message || raw.error || raw.message || 'Feed request failed');
    feedHealthMap.set(health.source_name, health);
    continue;
  }

  const item = extractItem(raw);
  if (!item.url || !item.title) {
    droppedNoUrlOrTitle += 1;
    continue;
  }
  if (!item.published) {
    droppedUndated += 1;
    continue;
  }
  if (item.published.getTime() < cutoffMs) {
    droppedOutsideWindow += 1;
    continue;
  }
  if (seen.has(item.url)) {
    droppedDuplicate += 1;
    continue;
  }
  seen.add(item.url);

  health.item_count += 1;
  if (health.status !== 'error') health.status = 'ok';
  feedHealthMap.set(health.source_name, health);

  kept.push({
    title: item.title,
    url: item.url,
    published: item.published.toISOString(),
    content: item.content,
    source_name: inferred.source_name,
    feed_url: inferred.feed_url || health.feed_url,
  });
}

kept.sort((a, b) => String(b.published).localeCompare(String(a.published)));

const generatedAt = new Date().toISOString();

return [{
  json: {
    generated_at: generatedAt,
    timezone: 'Europe/Paris',
    lookback_hours: LOOKBACK_HOURS,
    cutoff_iso: new Date(cutoffMs).toISOString(),
    feed_health: [...feedHealthMap.values()],
    stats: {
      incoming: incoming.length,
      kept: kept.length,
      dropped_no_url_or_title: droppedNoUrlOrTitle,
      dropped_undated: droppedUndated,
      dropped_outside_window: droppedOutsideWindow,
      dropped_duplicate: droppedDuplicate,
    },
    items: kept,
  },
}];

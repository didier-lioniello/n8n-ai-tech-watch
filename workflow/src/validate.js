/**
 * Reject any idea that has no known source URL, or that uses a number
 * which does not appear in the source title, snippet, URL or date.
 * Accepted ideas stay flagged needs_review — nothing is published here.
 */
const payload = $input.first().json;
const candidates = payload.candidates || [];

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
    url.protocol = url.protocol === 'http:' ? 'https:' : url.protocol;
    let href = url.toString();
    if (href.endsWith('/') && url.pathname !== '/') href = href.slice(0, -1);
    return href;
  } catch {
    return String(raw).trim().replace(/\/$/, '');
  }
}

const byUrl = new Map();
for (const item of candidates) {
  byUrl.set(canonUrl(item.url), item);
}

function extractNumberTokens(text) {
  const matches = String(text || '').match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\d+/g) || [];
  return matches;
}

function variantsOf(token) {
  const raw = String(token);
  const noComma = raw.replace(/,/g, '');
  const asSet = new Set([raw, noComma]);
  if (/^\d+$/.test(noComma)) {
    asSet.add(noComma);
    // 1000 -> 1,000
    asSet.add(noComma.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  }
  if (raw.includes('.')) {
    const trimmed = raw.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    asSet.add(trimmed);
  }
  return [...asSet];
}

function numberInText(token, text) {
  const haystack = String(text || '');
  return variantsOf(token).some((variant) => haystack.includes(variant));
}

function allowedText(idea, source) {
  const parts = [
    idea.source_url,
    idea.source_name,
    idea.published,
    idea.title,
  ];
  if (source) {
    parts.push(source.title, source.content, source.url, source.published, source.source_name);
  }
  return parts.filter(Boolean).join('\n');
}

const accepted = [];
const rejected = [];

for (const idea of (payload.ideas || [])) {
  const reasons = [];
  const url = canonUrl(idea.source_url);
  const source = byUrl.get(url);
  if (!url) reasons.push('missing source_url');
  else if (!source) reasons.push('source_url does not match a fetched item');

  const haystack = allowedText(idea, source);
  const claimed = [
    ...(Array.isArray(idea.facts) ? idea.facts : []),
    idea.post_angle || '',
    idea.title || '',
  ].join('\n');

  const seenNums = new Set();
  for (const token of extractNumberTokens(claimed)) {
    const key = token.replace(/,/g, '');
    if (seenNums.has(key)) continue;
    seenNums.add(key);
    if (!numberInText(token, haystack)) {
      reasons.push(`number ${token} was not found in the source text`);
    }
  }

  const record = {
    ...idea,
    source_url: idea.source_url || '',
    needs_review: true,
    validation: reasons.length ? 'rejected' : 'accepted',
    rejection_reasons: reasons,
  };
  if (source && !record.source_name) record.source_name = source.source_name;
  if (source && !record.score) record.score = source.score;
  if (source && !record.matched_keywords) record.matched_keywords = source.matched_keywords;
  if (source && !record.published) record.published = source.published;
  (reasons.length ? rejected : accepted).push(record);
}

return [{
  json: {
    ...payload,
    accepted,
    rejected,
    ideas: accepted,
    validation_stats: {
      accepted: accepted.length,
      rejected: rejected.length,
    },
  },
}];

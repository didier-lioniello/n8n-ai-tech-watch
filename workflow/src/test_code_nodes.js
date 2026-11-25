#!/usr/bin/env node
/**
 * Offline checks for the Code-node scripts, plus an optional live feed run
 * when --live is passed. None of these tests invent figures.
 */
const fs = require('fs');
const path = require('path');

const SRC = __dirname;
const ROOT = path.resolve(SRC, '../..');

function loadRun(filename) {
  const src = fs.readFileSync(path.join(SRC, filename), 'utf8');
  return function run(items, env = {}, refs = {}) {
    const $input = {
      all: () => items.map((json) => ({ json })),
      first: () => ({ json: items[0] }),
    };
    const $env = env;
    const $ = (name) => {
      if (!refs[name]) throw new Error(`unknown ref ${name}`);
      return refs[name];
    };
    return new Function('$input', '$env', '$', `"use strict";\n${src}`)($input, $env, $);
  };
}

const normalize = loadRun('normalize_window.js');
const score = loadRun('score_rank.js');
const prepare = loadRun('prepare_llm.js');
const parseOrFallback = loadRun('parse_or_fallback.js');
const validate = loadRun('validate.js');
const digest = loadRun('build_digest.js');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function jsonOf(result) {
  assert(Array.isArray(result) && result[0] && result[0].json, 'expected n8n item array');
  return result[0].json;
}

// --- Offline fixtures (synthetic URLs, no invented product figures) ---
const now = Date.now();
const hours = (h) => new Date(now - h * 3600 * 1000).toISOString();

const fixtures = [
  {
    title: 'OpenAI announces a new API for example tests',
    link: 'https://openai.com/news/example-api-test',
    pubDate: hours(5),
    isoDate: hours(5),
    content: 'OpenAI today released an example API. The post mentions 3 endpoints and a 30 day preview.',
    contentSnippet: 'OpenAI today released an example API. The post mentions 3 endpoints and a 30 day preview.',
    source_name: 'OpenAI News',
    feed_url: 'https://openai.com/news/rss.xml',
  },
  {
    title: 'Old post that must be dropped',
    link: 'https://openai.com/news/old',
    pubDate: hours(72),
    isoDate: hours(72),
    content: 'This is seventy two hours old and must leave the window.',
    source_name: 'OpenAI News',
    feed_url: 'https://openai.com/news/rss.xml',
  },
  {
    title: 'Duplicate URL with tracking',
    link: 'https://openai.com/news/example-api-test?utm_source=rss',
    pubDate: hours(4),
    isoDate: hours(4),
    content: 'Duplicate of the first item.',
    source_name: 'OpenAI News',
    feed_url: 'https://openai.com/news/rss.xml',
  },
  {
    title: 'Gemini research on agents',
    link: 'https://deepmind.google/blog/gemini-agents-example',
    pubDate: hours(10),
    isoDate: hours(10),
    content: 'Google DeepMind describes an agent research update. No extra figures here.',
    source_name: 'Google DeepMind',
    feed_url: 'https://www.deepmind.com/blog/rss.xml',
  },
  {
    title: 'A new conservative allocation method for agents',
    link: 'https://arxiv.org/abs/2601.00001',
    pubDate: hours(8),
    isoDate: hours(8),
    content: 'We study governance of autonomous agent systems and report a benchmark score of 12.5 on a toy set.',
    source_name: 'arXiv cs.AI',
    feed_url: 'https://rss.arxiv.org/rss/cs.AI',
  },
  {
    title: 'Unrelated typography notes',
    link: 'https://arxiv.org/abs/2601.00002',
    pubDate: hours(8),
    isoDate: hours(8),
    content: 'A typography preprint about ink, spacing and layout.',
    source_name: 'arXiv cs.AI',
    feed_url: 'https://rss.arxiv.org/rss/cs.AI',
  },
];

let passed = 0;

const normalized = jsonOf(normalize(fixtures, { LOOKBACK_HOURS: '48' }));
assert(normalized.items.length === 4, `expected 4 items in 48h window, got ${normalized.items.length}`);
assert(!normalized.items.some((i) => i.url.includes('utm_source')), 'tracking params should be stripped');
assert(!normalized.items.some((i) => i.url.endsWith('/old') || i.title.includes('Old post')), '72h item must be dropped');
assert(normalized.stats.dropped_duplicate >= 1, 'duplicate URL should be dropped');
passed += 1;
console.log('ok  normalize window, dedupe, 48h filter');

const ranked = jsonOf(score([normalized]));
assert(ranked.candidates.length >= 2, 'official posts should be kept');
assert(ranked.candidates.some((c) => c.source_name === 'OpenAI News'), 'OpenAI item missing');
assert(ranked.candidates.some((c) => c.source_name === 'Google DeepMind'), 'DeepMind item missing');
const typographyKept = ranked.candidates.some((c) => c.title.includes('typography'));
assert(!typographyKept, 'low-score typography arXiv paper should not be promoted');
passed += 1;
console.log('ok  keyword score & rank');

const prepared = jsonOf(prepare([ranked], {}));
assert(prepared.has_llm_key === false, 'has_llm_key should be false without OPENAI_API_KEY');
assert(prepared.llm_request.messages.length === 2, 'LLM request should have system + user messages');
passed += 1;
console.log('ok  prepare LLM request without a key');

const fallback = jsonOf(parseOrFallback([prepared]));
assert(fallback.llm_used === false, 'fallback should not claim LLM use');
assert(fallback.ideas.length === prepared.candidates.length, 'fallback should keep every candidate');
assert(fallback.ideas.every((i) => i.needs_review === true), 'every idea must need review');
assert(fallback.ideas.every((i) => i.facts.every((f) => {
  const src = prepared.candidates.find((c) => c.url === i.source_url);
  return src && (src.content.includes(f.replace(/\.\.\.$/, '').slice(0, 40)) || f.startsWith('Official title:'));
})), 'fallback facts must come from the source');
passed += 1;
console.log('ok  fallback ideas stay faithful to the source');

const valid = jsonOf(validate([fallback]));
assert(valid.accepted.length === fallback.ideas.length, 'clean fallback ideas should pass validation');
assert(valid.rejected.length === 0, 'no invented numbers in fallback path');
passed += 1;
console.log('ok  validation accepts source-faithful ideas');

const dirty = {
  ...fallback,
  ideas: [
    {
      title: 'Invented figure',
      source_url: fallback.ideas[0].source_url,
      source_name: fallback.ideas[0].source_name,
      published: fallback.ideas[0].published,
      facts: ['The launch reached 99999 users in two days.'],
      post_angle: 'Wow, 99999 users.',
      needs_review: true,
    },
    {
      title: 'Missing URL',
      source_url: '',
      facts: ['No link here.'],
      post_angle: 'Skip me.',
      needs_review: true,
    },
  ],
};
const rejected = jsonOf(validate([dirty]));
assert(rejected.accepted.length === 0, 'invented figures and missing URLs must not pass');
assert(rejected.rejected.length === 2, `expected 2 rejections, got ${rejected.rejected.length}`);
assert(rejected.rejected[0].rejection_reasons.some((r) => r.includes('99999')), 'should flag 99999');
passed += 1;
console.log('ok  validation rejects missing URLs and invented numbers');

const md = jsonOf(digest([valid]));
assert(md.markdown.includes('AI Tech Watch'), 'digest should have a title');
assert(md.markdown.includes('needs_review') || md.needs_review === true, 'digest must stay in review');
assert(md.accepted_count === valid.accepted.length, 'digest counts should match validation');
passed += 1;
console.log('ok  markdown digest builds');

async function liveRun() {
  const feeds = [
    { source_name: 'OpenAI News', feed_url: 'https://openai.com/news/rss.xml' },
    { source_name: 'Google DeepMind', feed_url: 'https://www.deepmind.com/blog/rss.xml' },
    { source_name: 'Google AI Blog', feed_url: 'https://blog.google/technology/ai/rss/' },
    { source_name: 'Hugging Face Blog', feed_url: 'https://huggingface.co/blog/feed.xml' },
    { source_name: 'arXiv cs.AI', feed_url: 'https://rss.arxiv.org/rss/cs.AI' },
  ];

  function textOf(xml, tag) {
    const cdata = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i'));
    if (cdata) return cdata[1];
    const plain = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    return plain ? plain[1].replace(/<[^>]+>/g, ' ').trim() : '';
  }

  function parseRss(xml, feed) {
    const blocks = xml.split(/<item[\s>]/i).slice(1);
    return blocks.map((block) => {
      const chunk = block.split(/<\/item>/i)[0];
      const title = textOf(chunk, 'title');
      const link = textOf(chunk, 'link') || textOf(chunk, 'guid');
      const pubDate = textOf(chunk, 'pubDate') || textOf(chunk, 'dc:date') || textOf(chunk, 'updated');
      const content = textOf(chunk, 'description') || textOf(chunk, 'content:encoded') || textOf(chunk, 'title');
      return {
        title,
        link,
        pubDate,
        isoDate: pubDate,
        content,
        contentSnippet: content,
        source_name: feed.source_name,
        feed_url: feed.feed_url,
      };
    });
  }

  const items = [];
  for (const feed of feeds) {
    const res = await fetch(feed.feed_url, {
      headers: { 'User-Agent': 'n8n-ai-tech-watch-tests/1.0', Accept: 'application/rss+xml, application/xml, text/xml' },
    });
    if (!res.ok) {
      console.log(`live  ${feed.source_name} HTTP ${res.status}`);
      items.push({ source_name: feed.source_name, feed_url: feed.feed_url, error: { message: `HTTP ${res.status}` } });
      continue;
    }
    const xml = await res.text();
    const parsed = parseRss(xml, feed);
    console.log(`live  ${feed.source_name}: ${parsed.length} items, HTTP ${res.status}`);
    items.push(...parsed);
  }

  const n = jsonOf(normalize(items, { LOOKBACK_HOURS: '48' }));
  const s = jsonOf(score([n]));
  const p = jsonOf(prepare([s], {}));
  const f = jsonOf(parseOrFallback([p]));
  const v = jsonOf(validate([f]));
  const d = jsonOf(digest([v]));
  const out = path.join(ROOT, 'output', 'live-pipeline-test.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, d.markdown);
  console.log(`ok  live pipeline: kept=${n.stats.kept} candidates=${s.ranking.candidates} accepted=${v.validation_stats.accepted} rejected=${v.validation_stats.rejected}`);
  console.log(`ok  wrote ${out}`);
}

const live = process.argv.includes('--live');
(async () => {
  if (live) await liveRun();
  console.log(`\n${passed} offline checks passed.`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

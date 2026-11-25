/**
 * Turn an n8n Error Trigger payload into a short Markdown incident note.
 */
const raw = $input.first().json;

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

const now = new Date().toISOString();

function formatParis(iso) {
  const date = new Date(iso || Date.now());
  if (Number.isNaN(date.getTime())) return String(iso);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(date).replace(',', '') + ' Europe/Paris';
}

const execution = raw.execution || raw;
const workflow = raw.workflow || {};
const error = execution.error || raw.error || raw;
const message = error.message || error.description || JSON.stringify(error);
const node = error.node || execution.lastNodeExecuted || 'unknown node';

const markdown = [
  '# AI Tech Watch — execution error',
  '',
  `Recorded: **${formatParis(now)}**`,
  `Workflow: **${workflow.name || 'AI Tech Watch'}**`,
  `Failed node: **${node}**`,
  '',
  '## Message',
  '',
  '```',
  String(message).slice(0, 2000),
  '```',
  '',
  'The official-feed requests are fail-open (`onError` continues the run).',
  'This note is for unhandled errors. Nothing was published.',
  '',
].join('\n');

return [{
  json: {
    generated_at: now,
    needs_review: true,
    error_message: String(message).slice(0, 2000),
    failed_node: node,
    markdown,
    digest_path: readEnv('ERROR_DIGEST_PATH', '/tmp/ai-tech-watch-error.md'),
  },
}];

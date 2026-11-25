#!/usr/bin/env python3
"""Assemble workflow/ai-tech-watch.json from the Code-node source files."""
from __future__ import annotations

import json
import uuid
from pathlib import Path

SRC = Path(__file__).parent
OUT = SRC.parent / "ai-tech-watch.json"
# Fixed namespace so node IDs stay stable across rebuilds.
NS = uuid.UUID("7c2e9b10-4a11-4d8f-9c3e-11a1e1000000")


def nid(name: str) -> str:
    return str(uuid.uuid5(NS, name))


def js(name: str) -> str:
    return (SRC / name).read_text(encoding="utf-8")


nodes: list[dict] = []
connections: dict = {}

SLACK = {"slackApi": {"id": "SLACK_CRED_PLACEHOLDER", "name": "Slack (placeholder)"}}
GMAIL = {"gmailOAuth2": {"id": "GMAIL_CRED_PLACEHOLDER", "name": "Gmail (placeholder)"}}
SHEETS = {"googleSheetsOAuth2Api": {"id": "SHEETS_CRED_PLACEHOLDER", "name": "Google Sheets (placeholder)"}}


def node(name, type_, version, pos, params, creds=None, **extra):
    item = {
        "parameters": params,
        "id": nid(name),
        "name": name,
        "type": type_,
        "typeVersion": version,
        "position": pos,
    }
    if creds:
        item["credentials"] = creds
    item.update(extra)
    nodes.append(item)
    return name


def connect(src, dst, out=0, inp=0):
    main = connections.setdefault(src, {"main": []})["main"]
    while len(main) <= out:
        main.append([])
    main[out].append({"node": dst, "type": "main", "index": inp})


def sticky(name, pos, width, height, color, content):
    return node(
        name,
        "n8n-nodes-base.stickyNote",
        1,
        pos,
        {"content": content, "width": width, "height": height, "color": color},
    )


def code(name, pos, filename, mode="runOnceForAllItems"):
    return node(
        name,
        "n8n-nodes-base.code",
        2,
        pos,
        {"mode": mode, "jsCode": js(filename)},
    )


def if_node(name, pos, left, op_type, operation, right=None):
    cond = {
        "id": nid(name + "-c"),
        "leftValue": left,
        "operator": {"type": op_type, "operation": operation},
    }
    if right is None:
        cond["operator"]["singleValue"] = True
        cond["rightValue"] = ""
    else:
        cond["rightValue"] = right
    return node(
        name,
        "n8n-nodes-base.if",
        2,
        pos,
        {
            "conditions": {
                "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose"},
                "conditions": [cond],
                "combinator": "and",
            },
            "options": {},
        },
    )


def set_tag(name, pos, source_name, feed_url):
    return node(
        name,
        "n8n-nodes-base.set",
        3.4,
        pos,
        {
            "mode": "manual",
            "assignments": {
                "assignments": [
                    {"id": nid(name + "-s"), "name": "source_name", "value": source_name, "type": "string"},
                    {"id": nid(name + "-f"), "name": "feed_url", "value": feed_url, "type": "string"},
                ]
            },
            "includeOtherFields": True,
            "options": {},
        },
    )


def rss(name, pos, url):
    return node(
        name,
        "n8n-nodes-base.rssFeedRead",
        1.1,
        pos,
        {"url": url, "options": {}},
        onError="continueRegularOutput",
        retryOnFail=True,
        maxTries=3,
        waitBetweenTries=2000,
    )


# ---------------------------------------------------------------------------
# Canvas layout (left to right): triggers, feeds, merge, rank, LLM, digest
# ---------------------------------------------------------------------------

sticky(
    "Note · Triggers",
    [-280, 120],
    280,
    360,
    5,
    "## 1. Triggers\n\n"
    "A **daily schedule** at 07:00 Europe/Paris, plus a **manual** trigger for on-demand runs.\n\n"
    "Both start the same fan-out: five official RSS/Atom feeds, fetched in parallel.",
)

node(
    "Trigger · Schedule (daily 07:00 Paris)",
    "n8n-nodes-base.scheduleTrigger",
    1.2,
    [40, 180],
    {"rule": {"interval": [{"field": "days", "daysInterval": 1, "triggerAtHour": 7, "triggerAtMinute": 0}]}},
)

node("Trigger · Manual", "n8n-nodes-base.manualTrigger", 1, [40, 400], {})

FEEDS = [
    ("RSS · OpenAI News", "Tag · OpenAI News", "OpenAI News", "https://openai.com/news/rss.xml", 0),
    ("RSS · Google DeepMind", "Tag · Google DeepMind", "Google DeepMind", "https://www.deepmind.com/blog/rss.xml", 160),
    ("RSS · Google AI Blog", "Tag · Google AI Blog", "Google AI Blog", "https://blog.google/technology/ai/rss/", 320),
    ("RSS · Hugging Face Blog", "Tag · Hugging Face Blog", "Hugging Face Blog", "https://huggingface.co/blog/feed.xml", 480),
    ("RSS · arXiv cs.AI", "Tag · arXiv cs.AI", "arXiv cs.AI", "https://rss.arxiv.org/rss/cs.AI", 640),
]

sticky(
    "Note · Official feeds",
    [260, -120],
    560,
    200,
    6,
    "## 2. Official feeds, in parallel\n\n"
    "OpenAI News, Google DeepMind, the Google AI Blog, the Hugging Face Blog, and arXiv cs.AI.\n\n"
    "Each request **retries twice** and **continues on failure**. One broken feed must never wipe the digest.\n\n"
    "URLs were checked live before being pinned here. There is no unofficial aggregator in this path.",
)

for rss_name, tag_name, source_name, url, y in FEEDS:
    rss(rss_name, [280, y], url)
    set_tag(tag_name, [560, y], source_name, url)
    connect("Trigger · Schedule (daily 07:00 Paris)", rss_name)
    connect("Trigger · Manual", rss_name)
    connect(rss_name, tag_name)

node(
    "Merge · All feeds",
    "n8n-nodes-base.merge",
    3,
    [840, 280],
    {"mode": "append", "numberInputs": 5, "options": {}},
)
for index, (_, tag_name, *_) in enumerate(FEEDS):
    connect(tag_name, "Merge · All feeds", inp=index)

sticky(
    "Note · Normalize & score",
    [1040, -120],
    420,
    200,
    4,
    "## 3. Normalize, window, score\n\n"
    "Canonicalize URLs, drop items older than **48 hours**, dedupe, then keyword-score.\n\n"
    "Official blog posts in the window are kept. arXiv papers need a minimum score and are capped, so the digest stays readable.",
)

code("Code · Normalize, dedupe & 48h window", [1120, 280], "normalize_window.js")
connect("Merge · All feeds", "Code · Normalize, dedupe & 48h window")

code("Code · Keyword score & rank", [1400, 280], "score_rank.js")
connect("Code · Normalize, dedupe & 48h window", "Code · Keyword score & rank")

sticky(
    "Note · LLM + fallback",
    [1640, -140],
    520,
    220,
    3,
    "## 4. LLM, with a safe fallback\n\n"
    "If `OPENAI_API_KEY` is set, one OpenAI-compatible HTTP request extracts facts and a post angle as **JSON**.\n\n"
    "The prompt forbids invented figures and requires the original `source_url`.\n\n"
    "If the key is missing or the call fails, the workflow **still builds a digest** from source titles and snippets.",
)

code("Code · Prepare LLM request", [1680, 280], "prepare_llm.js")
connect("Code · Keyword score & rank", "Code · Prepare LLM request")

if_node("IF · LLM credential present", [1960, 280], "={{ $json.has_llm_key }}", "boolean", "true")
connect("Code · Prepare LLM request", "IF · LLM credential present")

node(
    "HTTP · LLM extract facts & angles",
    "n8n-nodes-base.httpRequest",
    4.2,
    [2260, 120],
    {
        "method": "POST",
        "url": "={{ $json.llm_url }}",
        "sendHeaders": True,
        "headerParameters": {
            "parameters": [
                {"name": "Authorization", "value": "=Bearer {{ $env.OPENAI_API_KEY }}"},
                {"name": "Content-Type", "value": "application/json"},
            ]
        },
        "sendBody": True,
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify($json.llm_request) }}",
        "options": {"timeout": 120000, "response": {"response": {"responseFormat": "json"}}},
    },
    onError="continueRegularOutput",
    retryOnFail=True,
    maxTries=2,
    waitBetweenTries=2000,
)
connect("IF · LLM credential present", "HTTP · LLM extract facts & angles", out=0)

node("NoOp · Skip LLM", "n8n-nodes-base.noOp", 1, [2260, 440], {})
connect("IF · LLM credential present", "NoOp · Skip LLM", out=1)

node(
    "Merge · LLM or fallback",
    "n8n-nodes-base.merge",
    3,
    [2560, 280],
    {"mode": "append", "numberInputs": 2, "options": {}},
)
connect("HTTP · LLM extract facts & angles", "Merge · LLM or fallback", inp=0)
connect("NoOp · Skip LLM", "Merge · LLM or fallback", inp=1)

code("Code · Parse LLM or fallback", [2840, 280], "parse_or_fallback.js")
connect("Merge · LLM or fallback", "Code · Parse LLM or fallback")

sticky(
    "Note · Validate & digest",
    [3080, -140],
    480,
    220,
    2,
    "## 5. Validate, then write the digest\n\n"
    "An idea is **rejected** if it has no known source URL, or if it uses a number that does not appear in the source text.\n\n"
    "Accepted ideas still carry `needs_review: true`. This workflow never publishes.",
)

code("Code · Validate sources & figures", [3160, 280], "validate.js")
connect("Code · Parse LLM or fallback", "Code · Validate sources & figures")

code("Code · Build Markdown digest", [3440, 280], "build_digest.js")
connect("Code · Validate sources & figures", "Code · Build Markdown digest")

node(
    "Convert · Digest to file",
    "n8n-nodes-base.convertToFile",
    1.1,
    [3720, 80],
    {
        "operation": "toText",
        "sourceProperty": "markdown",
        "binaryPropertyName": "data",
        "options": {"fileName": "={{ $json.digest_filename || 'ai-tech-watch-digest.md' }}", "encoding": "utf8"},
    },
    onError="continueRegularOutput",
)
# Fork: writing the file must not wipe the digest JSON used by the review path.
connect("Code · Build Markdown digest", "Convert · Digest to file")

node(
    "Write · Digest to disk",
    "n8n-nodes-base.readWriteFile",
    1.1,
    [4000, 80],
    {
        "operation": "write",
        "fileName": "={{ $json.digest_path || '/tmp/ai-tech-watch-digest.md' }}",
        "dataPropertyName": "data",
        "options": {"append": False},
    },
    onError="continueRegularOutput",
)
connect("Convert · Digest to file", "Write · Digest to disk")

sticky(
    "Note · Human review & notify",
    [4240, -140],
    520,
    220,
    7,
    "## 6. Human review, optional notifications\n\n"
    "The digest is the approval step: every idea is flagged **needs review**.\n\n"
    "A Wait/form node is not used here, so a CLI run can finish. Add one later if you want in-app approval.\n\n"
    "Slack, Gmail and Sheets sit behind `ENABLE_NOTIFICATIONS=true` and use **placeholder credentials**. They stay off by default.",
)

if_node(
    "IF · Notifications enabled",
    [4280, 280],
    "={{ $json.notifications_enabled }}",
    "boolean",
    "true",
)
connect("Code · Build Markdown digest", "IF · Notifications enabled")

node("NoOp · Notifications off", "n8n-nodes-base.noOp", 1, [4600, 440], {})
connect("IF · Notifications enabled", "NoOp · Notifications off", out=1)

node(
    "Slack · Post digest (optional)",
    "n8n-nodes-base.slack",
    2.2,
    [4600, 40],
    {
        "select": "channel",
        "channelId": {"__rl": True, "value": "C0PLACEHOLDER", "mode": "id"},
        "text": "={{ $json.markdown || 'AI Tech Watch digest is ready for review.' }}",
        "otherOptions": {},
    },
    disabled=True,
)
connect("IF · Notifications enabled", "Slack · Post digest (optional)", out=0)

node(
    "Gmail · Email digest (optional)",
    "n8n-nodes-base.gmail",
    2.1,
    [4600, 200],
    {
        "resource": "message",
        "operation": "send",
        "sendTo": "you@example.com",
        "subject": "AI Tech Watch digest — needs review",
        "message": "={{ $json.markdown || 'The digest is ready for review.' }}",
        "options": {},
    },
    disabled=True,
)
connect("Slack · Post digest (optional)", "Gmail · Email digest (optional)")

node(
    "Sheets · Append ideas (optional)",
    "n8n-nodes-base.googleSheets",
    4.5,
    [4600, 360],
    {
        "operation": "append",
        "documentId": {"__rl": True, "value": "SHEETS_DOCUMENT_PLACEHOLDER", "mode": "id"},
        "sheetName": {"__rl": True, "value": "GID_PLACEHOLDER", "mode": "id"},
        "columns": {"mappingMode": "autoMapInputData", "value": {}},
        "options": {},
    },
    disabled=True,
)
connect("Gmail · Email digest (optional)", "Sheets · Append ideas (optional)")

# ---------------------------------------------------------------------------
# Error path (set this workflow as its Error workflow in n8n Settings)
# ---------------------------------------------------------------------------

sticky(
    "Note · Error handler",
    [40, 760],
    700,
    260,
    1,
    "## 7. Error handler\n\n"
    "In **Workflow Settings**, set *Error workflow* to this same workflow so the Error Trigger receives unhandled failures.\n\n"
    "Feed and LLM nodes already continue on failure and degrade to a source-only digest. This path is for everything else.\n\n"
    "It writes a short incident note. It never publishes.",
)

node("Error Trigger", "n8n-nodes-base.errorTrigger", 1, [80, 1060], {})
code("Code · Format error report", [360, 1060], "format_error.js")
connect("Error Trigger", "Code · Format error report")

node(
    "Convert · Error note to file",
    "n8n-nodes-base.convertToFile",
    1.1,
    [640, 1060],
    {
        "operation": "toText",
        "sourceProperty": "markdown",
        "binaryPropertyName": "data",
        "options": {"fileName": "ai-tech-watch-error.md", "encoding": "utf8"},
    },
    onError="continueRegularOutput",
)
connect("Code · Format error report", "Convert · Error note to file")

node(
    "Write · Error note to disk",
    "n8n-nodes-base.readWriteFile",
    1.1,
    [920, 1060],
    {
        "operation": "write",
        "fileName": "={{ $json.digest_path || '/tmp/ai-tech-watch-error.md' }}",
        "dataPropertyName": "data",
        "options": {"append": False},
    },
    onError="continueRegularOutput",
)
connect("Convert · Error note to file", "Write · Error note to disk")

workflow = {
    "name": "AI Tech Watch — official feeds to fact-checked post ideas",
    "nodes": nodes,
    "connections": connections,
    "active": False,
    "settings": {
        "executionOrder": "v1",
        "saveManualExecutions": True,
        "callerPolicy": "workflowsFromSameOwner",
        "timezone": "Europe/Paris",
        "errorWorkflow": "",
    },
    "pinData": {},
    "meta": {"templateCredsSetupCompleted": False},
    "tags": [{"name": "ai-tech-watch"}, {"name": "n8n"}, {"name": "editorial"}],
}

OUT.write_text(json.dumps(workflow, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"Wrote {OUT} ({len(nodes)} nodes, {len(connections)} sources)")


if __name__ == "__main__":
    pass

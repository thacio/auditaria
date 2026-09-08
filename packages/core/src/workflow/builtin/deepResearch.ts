/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: Port of Claude Code's only built-in workflow,
// `deep-research` (research 03 §6.1): Scope → Search → Fetch+Extract → 3-vote
// Verify → Synthesize, using Auditaria's google_web_search / web_fetch tools.
// Invoke as workflow({name: 'deep-research', args: '<question>'}).

export const DEEP_RESEARCH_SCRIPT = String.raw`export const meta = {
  name: 'deep-research',
  description: 'Multi-angle web research with source verification: decompose the question, search from several angles, fetch and extract claims, adversarially verify each claim with three votes, then synthesize a cited report',
  whenToUse: 'When the user asks for research on a question whose answer lives on the web and should be verified rather than recalled: state of the art, comparisons, recent developments, medical or technical questions with authoritative sources.',
  phases: [
    { title: 'Scope', detail: 'decompose the question into 3-6 search angles' },
    { title: 'Search', detail: 'one searcher per angle, URL-deduplicated as they finish' },
    { title: 'Fetch', detail: 'fetch each unique source and extract its claims' },
    { title: 'Verify', detail: '3-vote adversarial verification per claim (2/3 refutes to kill)' },
    { title: 'Synthesize', detail: 'merge semantic duplicates, rank by confidence, cite sources' },
  ],
}

const VOTES_PER_CLAIM = 3
const REFUTATIONS_REQUIRED = 2
const MAX_FETCH = 15
const MAX_VERIFY_CLAIMS = 25

const SCOPE_SCHEMA = {
  type: 'object', required: ['question', 'angles', 'summary'],
  properties: {
    question: { type: 'string' },
    summary: { type: 'string' },
    angles: { type: 'array', minItems: 3, maxItems: 6, items: {
      type: 'object', required: ['label', 'query'],
      properties: { label: { type: 'string' }, query: { type: 'string' }, rationale: { type: 'string' } },
    } },
  },
}
const SEARCH_SCHEMA = {
  type: 'object', required: ['results'],
  properties: {
    results: { type: 'array', maxItems: 6, items: {
      type: 'object', required: ['url', 'title', 'relevance'],
      properties: { url: { type: 'string' }, title: { type: 'string' }, snippet: { type: 'string' }, relevance: { type: 'string', enum: ['high', 'medium', 'low'] } },
    } },
  },
}
const EXTRACT_SCHEMA = {
  type: 'object', required: ['claims', 'sourceQuality'],
  properties: {
    sourceQuality: { type: 'string', enum: ['primary', 'secondary', 'blog', 'forum', 'unreliable'] },
    publishDate: { type: 'string' },
    claims: { type: 'array', maxItems: 5, items: {
      type: 'object', required: ['claim', 'quote', 'importance'],
      properties: { claim: { type: 'string' }, quote: { type: 'string' }, importance: { type: 'string', enum: ['central', 'supporting', 'tangential'] } },
    } },
  },
}
const VERDICT_SCHEMA = {
  type: 'object', required: ['refuted', 'evidence', 'confidence'],
  properties: {
    refuted: { type: 'boolean' }, evidence: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, counterSource: { type: 'string' },
  },
}
const REPORT_SCHEMA = {
  type: 'object', required: ['summary', 'findings', 'caveats'],
  properties: {
    summary: { type: 'string' },
    findings: { type: 'array', items: {
      type: 'object', required: ['claim', 'confidence', 'sources', 'evidence'],
      properties: { claim: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, sources: { type: 'array', items: { type: 'string' } }, evidence: { type: 'string' }, vote: { type: 'string' } },
    } },
    caveats: { type: 'string' },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}

const stripControl = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff"\u201c-\u201f]/g, '')
const normURL = (u) => {
  const m = String(u).match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#\\]*@)?(?:www\.)?([^/:?#@\\]+)(?::\d+)?([^?#]*)/i)
  return m ? (m[1] + m[2].replace(/\/$/, '')).toLowerCase() : String(u).toLowerCase()
}
const hostLabel = (u) => {
  const m = String(u).match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#\\]*@)?(?:www\.)?([^/:?#@\\]+)/i)
  const host = m ? stripControl(m[1]).toLowerCase() : ''
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host) ? host.slice(0, 40) : 'source'
}

phase('Scope')
const QUESTION = (typeof args === 'string' && args.trim()) || (args && typeof args === 'object' && typeof args.question === 'string' && args.question.trim()) || ''
if (!QUESTION) {
  return { error: "No research question provided. Pass it as args: workflow({name: 'deep-research', args: '<question>'})." }
}
const scope = await agent(
  'Decompose this research question into complementary web-search angles.\n\n## Question\n' + QUESTION +
  '\n\n## Task\nGenerate 3-6 distinct search queries that together cover the question from different angles (broad/primary, academic/technical, recent news, contrarian/skeptical, practitioner). Make each query specific enough to surface high-signal results; avoid redundancy. Return the question (verbatim or lightly normalized), a 1-2 sentence strategy, and the angles. Do not search yet.',
  { label: 'scope', schema: SCOPE_SCHEMA },
)
if (!scope) return { error: 'Scope agent returned no result — cannot decompose the research question.' }
log('Q: ' + QUESTION.slice(0, 80) + (QUESTION.length > 80 ? '…' : ''))
log('Decomposed into ' + scope.angles.length + ' angles: ' + scope.angles.map((a) => a.label).join(', '))

const seenUrls = new Set()
const fetchQueue = []
phase('Search')
const extracted = await pipeline(
  scope.angles,
  (angle) => agent(
    'Search the web for: ' + angle.query + '\n\nContext: this is the "' + angle.label + '" angle of the research question "' + QUESTION + '". Use the google_web_search tool, then return up to 6 results with url, title, a one-line snippet and a relevance rating. Prefer primary and authoritative sources; skip obvious spam.',
    { label: 'search:' + stripControl(angle.label).slice(0, 30), phase: 'Search', schema: SEARCH_SCHEMA },
  ),
  (search, angle) => {
    if (!search) return []
    const fresh = []
    for (const r of search.results) {
      const key = normURL(r.url)
      if (seenUrls.has(key) || fetchQueue.length + fresh.length >= MAX_FETCH) continue
      seenUrls.add(key)
      fresh.push({ url: r.url, title: r.title, angle: angle.label, relevance: r.relevance })
    }
    fetchQueue.push(...fresh)
    return fresh
  },
  (fresh) => parallel(fresh.map((src) => () =>
    agent(
      'Fetch this page with the web_fetch tool and extract its claims relevant to the research question.\n\nURL: ' + src.url + '\nTitle: ' + stripControl(src.title) + '\nQuestion: ' + QUESTION +
      '\n\nReturn up to 5 claims (each with a short verbatim quote and an importance rating), the source quality, and the publish date if visible. If the page cannot be fetched, return an empty claims list with sourceQuality "unreliable".',
      { label: 'fetch:' + hostLabel(src.url), phase: 'Fetch', schema: EXTRACT_SCHEMA },
    ).then((ex) => ex && { ...ex, url: src.url, title: src.title }),
  )),
)
const sources = extracted.flat().filter(Boolean)
const claims = []
for (const src of sources) {
  for (const c of src.claims) {
    if (c.importance === 'tangential') continue
    claims.push({ claim: stripControl(c.claim), quote: stripControl(c.quote), url: src.url, sourceQuality: src.sourceQuality })
  }
}
log(sources.length + ' sources fetched, ' + claims.length + ' claims extracted')

phase('Verify')
const toVerify = claims.slice(0, MAX_VERIFY_CLAIMS)
if (claims.length > MAX_VERIFY_CLAIMS) log('Verifying the first ' + MAX_VERIFY_CLAIMS + ' claims of ' + claims.length)
const verified = await pipeline(toVerify, (c, _item, i) =>
  parallel(Array.from({ length: VOTES_PER_CLAIM }, (_, v) => () =>
    agent(
      'You are verifier #' + (v + 1) + '. Try to REFUTE this claim using the web (google_web_search / web_fetch). Default to refuted=true if you cannot find independent support.\n\nClaim: ' + c.claim + '\nQuoted from ' + c.url + ': "' + c.quote + '"\nResearch question: ' + QUESTION + '\n\nReturn refuted (boolean), your evidence, a confidence rating, and a counterSource URL if you found one.',
      { label: 'verify:' + (i + 1) + '/' + (v + 1), phase: 'Verify', schema: VERDICT_SCHEMA },
    ),
  )).then((votes) => {
    const valid = votes.filter(Boolean)
    const refutes = valid.filter((x) => x.refuted).length
    return { ...c, votes: valid, refutes, survives: valid.length > 0 && refutes < REFUTATIONS_REQUIRED }
  }),
)
const surviving = verified.filter((v) => v && v.survives)
log(surviving.length + '/' + toVerify.length + ' claims survived verification')

phase('Synthesize')
const report = await agent(
  'Write the research report for: ' + QUESTION + '\n\nVerified claims (JSON):\n' + JSON.stringify(surviving.map((s) => ({ claim: s.claim, url: s.url, sourceQuality: s.sourceQuality, refutes: s.refutes + '/' + s.votes.length, evidence: s.votes.map((x) => x.evidence).join(' | ') }))) +
  '\n\nRefuted claims (for the caveats section):\n' + JSON.stringify(verified.filter((v) => v && !v.survives).map((s) => ({ claim: s.claim, url: s.url }))) +
  '\n\nMerge semantic duplicates, rank findings by confidence, cite sources by URL, state caveats and open questions plainly. Do not add claims that are not in the verified list.',
  { label: 'synthesize', schema: REPORT_SCHEMA },
)
return { question: QUESTION, angles: scope.angles, sourcesFetched: sources.length, claimsExtracted: claims.length, claimsVerified: surviving.length, report }
`;

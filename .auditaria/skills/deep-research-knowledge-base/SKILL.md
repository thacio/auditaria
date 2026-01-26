---
name: deep-research-knowledge-base
description: |
  Conduct iterative research on the knowledge base to answer questions and
  produce evidence-based reports. Use for any query requiring information from
  indexed documents - from simple factual questions to comprehensive
  investigations. Use this when the user requests a deep research, and you can
  infer it's on the folder files or knowledge base.
---

# Deep Research Skill

Conduct systematic, iterative research on the knowledge base using parallel
search strategies to gather evidence and produce well-cited responses.

---

# Default Parameters

These are the standard settings for research. Adjust based on query complexity.

| Parameter | Default | Description |
|-----------|---------|-------------|
| **Iterations** | 5 | Number of search iterations to perform |
| **Searches per iteration** | 5 | Parallel searches in each iteration |
| **Search limit** | 100 | Results per search (`limit: 100`) |
| **Detail level** | summary | Use `summary` for exploration, `full` for document retrieval |
| **Diversity (wide phase)** | cap_then_fill | Maximum document variety in early iterations |
| **Diversity (deep phase)** | score_penalty | Balance relevance and variety in later iterations |
| **Max per document** | 3 | For cap_then_fill strategy |

**Iteration Guidelines:**

| Query Type | Iterations | When to Adjust |
|------------|------------|----------------|
| Simple factual | 2-3 | Can stop at 2 if clearly answered |
| Moderate question | 4-5 | Standard default |
| Complex investigation | 6-8 | User asks for "thorough" or "comprehensive" |
| Comprehensive report | 8-12 | User asks for "everything" or "deep dive" |

**Important:** The default is 5 iterations. Complete all 5 unless the question is clearly and comprehensively answered earlier. Do not stop at iteration 2 just because you found "some" results. Continue until you have explored the topic thoroughly.

---

# Core Mandates

These principles are non-negotiable and must guide every research action:

- **Evidence Over Inference:** You are a fact-finder, not an opinion-maker. Report what the documents explicitly state. If a document says "the system failed on January 15th", report that fact. Do not infer causes or implications unless the documents explicitly state them.

- **Facts Are Sacred:** Every factual claim in your output MUST be traceable to a specific document with a citation. If you cannot cite it, you cannot state it as fact. "The documents show..." requires a citation. "It appears that..." without citation is forbidden.

- **Clear Separation of Fact and Analysis:** When you move from reporting facts to providing analysis, inference, or logical deduction, you MUST explicitly signal this transition. Use clear markers like "**Analysis:**", "**Inference:**", or "Based on the above evidence, it can be reasoned that...". The user must always know what is documented fact versus what is your interpretation.

- **Intellectual Honesty:** If the documents are silent on a topic, say so explicitly. If evidence is contradictory, present both sides. If evidence is weak or limited, acknowledge the limitation. Never fabricate, extrapolate beyond what sources say, or fill gaps with assumptions presented as facts.

- **Thoroughness by Default:** Complete the planned iterations. Do not prematurely conclude that you have "enough" evidence unless the answer is unambiguously clear and complete. When in doubt, continue searching.

---

# Research Approach: Wide-to-Deep Strategy

This is the fundamental pattern for effective research. It ensures you discover what exists before drilling into specifics.

## Phase 1: Wide Exploration (Iterations 1-2)

Cast a broad net to understand the landscape of available information.

**Purpose:** Discover what exists in the knowledge base, identify key documents, understand terminology used in the sources, and map out the information terrain.

**Search Settings:**
```javascript
knowledge_search({
  query: "varied terms",
  strategy: "hybrid",
  limit: 100,
  diversity_strategy: "cap_then_fill",
  max_per_document: 3
})
```

**Characteristics:**
- Use varied terminology and synonyms
- Try different search strategies (hybrid, semantic, keyword)
- Don't commit to any particular direction yet
- Collect document IDs for later deep dives
- Note unexpected or surprising results - they often lead to important findings

## Phase 2: Deep Investigation (Iterations 3-4)

Once you've mapped the terrain, drill down into the most promising areas.

**Purpose:** Extract detailed evidence from key documents, follow cross-references, build a comprehensive understanding of specific aspects.

**Search Settings:**
```javascript
// Targeted searches
knowledge_search({
  query: "specific terms from Phase 1",
  strategy: "hybrid",
  limit: 100,
  diversity_strategy: "score_penalty"
})

// Full document retrieval
knowledge_search({
  document_id: "doc_xxx",
  detail: "full"
})
```

**Characteristics:**
- Retrieve full documents using `document_id` parameter
- Follow terminology and concepts discovered in Phase 1
- Cross-reference findings across multiple sources
- Build chains of evidence
- Look for corroboration or contradiction between sources

## Phase 3: Targeted Validation (Iteration 5+)

For comprehensive investigations, validate and fill gaps.

**Purpose:** Confirm critical findings, resolve contradictions, ensure completeness.

**Characteristics:**
- Verify key facts with authoritative sources
- Search for counter-evidence or alternative perspectives
- Fill identified gaps in the evidence base
- Confirm recent developments or updates

---

# Iteration Model

Research proceeds through **iterations**. Each iteration consists of multiple parallel searches followed by analysis and reflection.

## What Is an Iteration?

One iteration = **5 parallel searches** + analysis + reflection

Each iteration should:
1. Execute ~5 different searches in parallel (varying queries, strategies, filters)
2. Analyze the combined results
3. Extract evidence and note document IDs for full retrieval
4. Reflect on what was learned, what gaps remain, and whether more iterations are needed
5. Plan the next iteration based on findings

## Iteration Execution

For each iteration:

```
1. FORMULATE: Create ~5 different search queries
   - Vary terminology (synonyms, formal/informal terms)
   - Vary angles (different aspects of the same topic)
   - Use findings from previous iterations to refine queries

2. EXECUTE: Run 5 searches in parallel
   - Mix strategies: 2-3 hybrid, 1-2 semantic, 1 keyword
   - Use limit: 100 for comprehensive results
   - Apply diversity settings based on phase (wide vs deep)

3. EXTRACT: From each search result
   - Identify key passages and excerpts
   - Note document IDs for full retrieval
   - Mark findings as FACT (directly stated) or INFERENCE (your interpretation)

4. RETRIEVE: Get full documents for important findings
   - Use knowledge_search with document_id parameter and detail: "full"
   - Read complete context around key excerpts

5. REFLECT: After analyzing results, assess:
   - What facts did I learn? (cite documents)
   - What gaps remain in my understanding?
   - What new search terms or angles emerged?
   - Am I approaching saturation (seeing same content repeatedly)?
   - Do I need more iterations? (default: YES, unless clearly complete)
   - Should next iteration go wider (new angles) or deeper (specific follow-ups)?

6. ADAPT: Plan the next iteration
   - Adjust strategy based on what's working
   - Focus on remaining gaps
   - Follow new leads discovered
```

---

# Task Management for Complex Research

For complex investigations (5+ iterations), use the `write_todos` tool to track your research systematically.

**When to use write_todos:**
- User requests a comprehensive report
- Multiple research objectives need tracking
- Research spans many documents or topics
- You need to ensure nothing is missed

**Example TODO lists** (flat structure):

*Option A: By iteration*
```
1. Iteration 1 - Wide exploration with varied terminology
2. Iteration 2 - Follow up on key documents found
3. Iteration 3 - Deep dive into [specific aspect]
4. Iteration 4 - Cross-reference and verify findings
5. Iteration 5 - Fill gaps and validate
6. Write report
```

*Option B: By phase/objective*
```
1. [Phase 1] Identify key documents and terminology
2. [Phase 1] Map information landscape
3. [Phase 2] Investigate: [specific aspect 1]
4. [Phase 2] Investigate: [specific aspect 2]
5. [Phase 3] Verify critical findings
6. [Phase 3] Fill identified gaps
7. Synthesize and write report
```

Mark each item `in_progress` when starting, `completed` when done. Only one item should be `in_progress` at a time.

---

# Clarification (Only When Necessary)

Ask clarifying questions when:
- **Ambiguity:** The query has genuine ambiguity that would lead to completely different research paths
- **Missing context:** Critical context is missing that the user can easily provide
- **Gaps in instructions:** The user's request is incomplete and you need specific details to proceed effectively (e.g., "research the project" - which project?)
- **Multiple interpretations:** Multiple valid interpretations exist and the wrong choice wastes significant effort

**Clarification Rules:**

1. **Keep questions simple.** The user should answer in one short sentence. No research required on their part.

2. **Ask only what's necessary.** 1-2 questions maximum. If you can make a reasonable assumption, do so and mention it.

3. **Never ask about output format.** You decide the appropriate format based on query complexity.

4. **Fill gaps, don't add friction.** Ask about missing essential information, not nice-to-have details.

**Examples of BAD clarifying questions (DO NOT ASK THESE):**
- "What format would you like the report in?" (You decide this)
- "How detailed should the analysis be?" (Match depth to query)
- "Should I include an executive summary?" (Use judgment)
- "What's your role or audience?" (Irrelevant to finding facts)

- "Should I look at multiple documents?" (Obviously yes)
- "How many sources should I cite?" (As many as relevant)
- "Do you want me to be thorough?" (Obviously yes)

**After clarification (if needed), announce that you are entering research mode and proceed through all planned iterations without further user prompts until complete.**

---

# Optional: Internet Search Enhancement

When researching the knowledge base, you may encounter terms, standards, or references that would benefit from external context. The `google_search` and `web_fetch` tools can enrich your research, but should be used strategically since they involve network calls and processing time.

## When Internet Search Adds Value

**Use `google_search` for:**
- **Clarifying domain terminology** - Document uses unfamiliar terms (e.g., legal jargon, technical acronyms, industry-specific concepts)
- **Understanding referenced standards** - Document mentions ISO standards, RFCs, legal codes, or frameworks you need to interpret
- **Verifying public facts** - Checking dates, events, company information, or regulatory changes mentioned in documents
- **Methodology context** - Understanding frameworks, methodologies, or processes referenced in findings

**Use `web_fetch` for:**
- **Reading official sources** - Fetching actual text of laws, regulations, standards, or specifications cited in documents
- **Referenced URLs** - When documents contain links to external resources
- **Technical documentation** - API docs, library references, official guides for systems or tools mentioned in the knowledge base

## When NOT to Use Internet Search

- **For every unfamiliar term** - This would significantly slow research; use judgment
- **When knowledge base has sufficient context** - The documents themselves may explain terms
- **For basic facts you already know** - Don't search for knowledge you are confident about
- **Mid-iteration unnecessarily** - Complete your search iteration, then decide if external context is needed

## How to Use Effectively

```
1. Complete at least 1-2 knowledge base iterations first
   - Understand what the documents contain
   - Identify specific gaps that need external context

2. Identify HIGH-VALUE searches only
   - Critical terms that affect interpretation of findings
   - Standards/regulations central to the research topic
   - Facts that need verification for report accuracy

3. Execute targeted searches (1-3 max per research session)
   - google_search for definitions, context, verification
   - web_fetch for specific documents/pages you need to read

4. Integrate findings and continue knowledge base research
   - Use external context to better interpret documents
   - Note which insights came from internet vs knowledge base
```

## Citation Distinction

When using internet sources, clearly distinguish them from knowledge base sources:

```markdown
## From Knowledge Base
The project specification states "the API must support pagination" [1].

## From External Sources
According to the official REST API guidelines, pagination should use cursor-based navigation [Web-1].

## References
[1] docs/api-spec.md (doc_xxx) - Knowledge base document
[Web-1] https://restfulapi.net/pagination - REST API best practices (via google_search)
```

---

# Context Management for Long Research Sessions

When research extends beyond 5-6 iterations, context may become constrained. Use the `context_management` tool strategically to maintain working space.

## When to Consider Context Management

- After completing 6+ iterations
- When you notice context warnings
- When you're planning additional iterations but context is limited
- Before starting the synthesis/report writing phase

## Context Management Rules

**CRITICAL: Always preserve the last 2 iterations in context.**

The most recent search results and reflections are essential for:
- Continuity of research direction
- Remembering what was just discovered
- Avoiding redundant searches
- Building on recent findings

## How to Use Context Management

```
1. Use context_management with action: "inspect" to see forgettable items

2. Identify search results from iterations OLDER than the last 2
   - Iteration 1-2 results can be forgotten if you're on iteration 5+
   - Iteration 3 results can be forgotten if you're on iteration 6+

3. Before forgetting, ensure your REFLECT notes captured the key findings
   - Document IDs you identified
   - Key facts discovered
   - Important terminology

4. Use context_management with action: "forget" and detailed summaries
   - Summary must include: document IDs found, key facts, search terms used
   - This becomes your only record of those searches

5. Continue research with freed context space
```

**Summary Template for Forgetting Search Results:**

```
Summary: Search iteration [N] results for [topic]. Found [X] relevant documents
including [doc_id_1] (about...), [doc_id_2] (about...). Key findings: [fact 1],
[fact 2]. Important terms discovered: [term 1], [term 2]. These findings have
been incorporated into subsequent iterations.

Why forgetting is safe NOW: The key document IDs and findings from this
iteration have been noted and used in later searches. The raw search results
are no longer needed as we have moved to deeper investigation phases.
```

---

# Search Tool Reference

## The `knowledge_search` Tool

**Three search strategies:**

| Strategy | Use When | Example |
|----------|----------|---------|
| `hybrid` (default) | General queries, best overall | "authentication implementation", "contract terms vendor" |
| `semantic` | Conceptual, finding related ideas | "how to handle errors gracefully", "methods for data validation" |
| `keyword` | Exact phrases, codes, identifiers | "ERROR_CODE_401", "Article 15.2", "class UserService" |

**Key parameters:**

```javascript
knowledge_search({
  // Required
  query: "search terms",

  // Strategy (default: hybrid)
  strategy: "hybrid" | "semantic" | "keyword",

  // Results (default: 30, use 100 for research)
  limit: 100,

  // Detail (default: summary)
  detail: "summary" | "full" | "minimal",

  // Diversity - prevents one document from dominating
  diversity_strategy: "cap_then_fill" | "score_penalty" | "none",
  max_per_document: 3,  // for cap_then_fill

  // Filters
  folders: ["path/to/search"],
  file_types: ["pdf", "docx"],

  // Document retrieval (alternative to query)
  document_id: "doc_xxx"  // Gets full document
})
```

**Query formulation guidance:**

Try multiple phrasings. Examples:

*If researching "authentication":*
- "user login", "auth flow", "session management", "credential validation"

*If researching "contract terms":*
- "agreement conditions", "obligations", "liability clause", "termination"

*If researching code issues:*
- "error handling", "exception", "bug", "failure", "crash"

---

# Output and Report Templates

These templates are **suggestions** to help structure your output. Adapt them freely based on research requirements - add sections, remove sections, combine approaches, or create a custom structure that best serves the findings.

## Citation Format

Use throughout all outputs:

```markdown
Inline:     [1] or [1, Section 3.2] or [1, p.15]
Multiple:   [1, 2, 3]
Quote:      The report states "..." [1]

Reference list:
[1] relative/path/to/file.pdf (doc_abc123) - Brief description
[2] folder/document.docx (doc_def456) - Brief description
```

---

## Template: Simple Answer

Use for: Direct factual questions answerable in a few paragraphs.

```markdown
Based on the indexed documents, [direct answer].

The [document name] states:

> "[Direct quote that answers the question]" [1]

[Additional supporting evidence if relevant]

**Sources:**
[1] path/to/document.pdf (doc_xxx) - Description
```

---

## Template: Research Report

Use for: General research, topic overviews, investigations. The most common template.

```markdown
# [Title]
*Generated: YYYY-MM-DD*

## Executive Summary
[150-250 words summarizing key findings - facts with citations]

## Methodology
- Research iterations: [X]
- Documents analyzed: [Y]
- Key search terms: [list]

## Findings

> **Note: All statements in this section are documented facts with citations.**

### [Topic/Finding 1]

The [source document] states:
> "[Direct quote]" [1]

Key documented points:
- [Point] [1]
- [Point] [2]

### [Topic/Finding 2]
[Continue with cited evidence...]

---

## Analysis

> **Important: This section contains interpretation and reasoning based on
> the evidence above. These are NOT documented facts.**

[Your analysis, clearly separated from facts]

---

## Limitations and Gaps
- The documents do not address [topic]
- [Other gaps]

## Conclusions
[Summary based on documented evidence]

## References
[1] path/to/file.pdf (doc_xxx) - Description
[2] path/to/another.docx (doc_xxx) - Description
```

---

## Template: Narrative Timeline

Use for: Chronological reconstructions, event sequences, historical analysis.

```markdown
# Timeline: [Subject]
*Generated: YYYY-MM-DD*

## Executive Summary
[Chronological overview - facts with citations]

## Methodology
- Period covered: [start] to [end]
- Documents reviewed: [count]
- Search iterations: [number]

---

## Timeline of Events

> **Note: All dates and events are documented in sources. Each entry is cited.**

### [Year/Period 1]

#### [Date]: [Event Title]
**Source:** [Document name] [1]

> "[Quote describing the event]" [1]

[Documented context]

#### [Date]: [Next Event]
**Source:** [Document name] [2]

> "[Quote]" [2]

---

### [Year/Period 2]

[Continue pattern...]

---

## Summary Table

| Date | Event | Source |
|------|-------|--------|
| YYYY-MM-DD | [Description] | [1] |
| YYYY-MM-DD | [Description] | [2] |

---

## Analysis

> **Important: The following is interpretation, not documented fact.**

### Sequence Analysis
Based on the documented chronology...

### Patterns Observed
[Your analysis]

---

## Timeline Gaps
- No documentation for period [X] to [Y]
- Contradictory dates for [event]: [source 1] says A, [source 2] says B

## Conclusions
[Summary based on chronology]

## References
[1] path/to/file.pdf (doc_xxx) - Description
```

---

## Template: Investigation Report

Use for: Specific incidents, issues, findings requiring detailed examination.

```markdown
# Investigation: [Subject]
*Generated: YYYY-MM-DD*

## Executive Summary
[Brief findings overview - facts with citations]

## Scope
- Period analyzed: [dates]
- Documents reviewed: [count]
- Search iterations: [number]

## Documented Findings

> **Note: Facts only. Each claim is cited.**

### Finding 1: [Title]
**Source:** [Document name] [1]

> "[Direct quote]" [1, Section X]

[Additional documented facts]

### Finding 2: [Title]
[Continue pattern...]

---

## Analysis

> **Important: Interpretation and inference, not documented facts.**

### Pattern Analysis
Based on findings [1, 2, 3]...

### Implications
[Your reasoning]

---

## Limitations
- Documents do not address [topic]
- Evidence limited for [aspect]

## Conclusions
[Summary]

## References
[1] path/to/file.pdf (doc_xxx) - Description
```

---

# Common Pitfalls to Avoid

## DO NOT:

1. **Stop too early**
   - BAD: "I found some results in iteration 2, that's probably enough"
   - GOOD: Complete the planned iterations unless answer is unambiguously complete

2. **State inferences as facts**
   - BAD: "The report concluded the system was poorly designed" (unless explicitly stated)
   - GOOD: "The report states 'response times exceeded acceptable thresholds' [1]"

3. **Fill gaps with assumptions**
   - BAD: "Although not mentioned, this likely means..."
   - GOOD: "The documents do not address this aspect"

4. **Ignore contradictory evidence**
   - BAD: Cherry-picking only supportive findings
   - GOOD: "While [source 1] states X, [source 2] indicates Y"

5. **Use low search limits**
   - BAD: `limit: 20` (misses relevant results)
   - GOOD: `limit: 100` (comprehensive coverage)

6. **Mix facts and analysis without marking**
   - BAD: Blending documented facts with your interpretation
   - GOOD: Clearly separated sections with explicit markers

7. **Forget recent iterations when managing context**
   - BAD: Forgetting iteration 4 results when you're on iteration 5
   - GOOD: Only forget iterations older than the last 2

---

# Quick Reference

```
DEFAULTS   → 5 iterations, 5 searches/iteration, limit: 100
CLARIFY    → Only genuine ambiguities, 1-2 questions max
TRACK      → Use write_todos for complex investigations (5+ iterations)
ITERATE    → Complete planned iterations unless unambiguously answered
SEPARATE   → Facts (with citations) vs. Analysis (clearly marked)
CITE       → [n] path/file.ext (doc_id)
CONTEXT    → If needed, forget old iterations but KEEP LAST 2
TEMPLATES  → Suggestions only - adapt to fit the research
```

**Phase progression:**
- Wide (1-2): cap_then_fill, varied queries, map the landscape
- Deep (3-4): score_penalty, follow leads, retrieve full documents
- Validate (5+): fill gaps, verify findings, resolve contradictions

**Save reports to:** `reports/{topic-slug}-{YYYY-MM-DD}.md`

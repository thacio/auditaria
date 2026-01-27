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
| **Iterations** | 7 (minimum) | Number of search iterations to perform |
| **Searches per iteration** | 5 | Parallel searches in each iteration |
| **Search limit** | 100 | Results per search (`limit: 100`) |
| **Detail level** | summary | Use `summary` for exploration, `full` for document retrieval |
| **Diversity (wide phase)** | cap_then_fill | Maximum document variety in early iterations |
| **Diversity (deep phase)** | score_penalty | Balance relevance and variety in later iterations |
| **Max per document** | 3 | For cap_then_fill strategy |

**Iteration Guidelines:**

| Query Type | Iterations | Notes |
|------------|------------|-------|
| Standard research | 7 | Minimum for any research task |
| Complex investigation | 8-10 | User asks for "thorough" or "comprehensive", usually on demand |
| Comprehensive report | 10-15 | User asks for "everything" or "deep dive" |

**Important:** The minimum is 7 iterations. Complete ALL planned iterations - do not stop early. Each iteration should actively explore and discover new information. The user may request more iterations, and you MUST follow their instructions.

---

# Core Mandates

These principles are non-negotiable and must guide every research action:

- **Evidence Over Inference:** You are a fact-finder, not an opinion-maker. Report what the documents explicitly state. If a document says "the system failed on January 15th", report that fact. Do not infer causes or implications unless the documents explicitly state them.

- **Facts Are Sacred:** Every factual claim in your output MUST be traceable to a specific document with a citation. If you cannot cite it, you cannot state it as fact. "The documents show..." requires a citation. "It appears that..." without citation is forbidden.

- **Clear Separation of Fact and Analysis:** When you move from reporting facts to providing analysis, inference, or logical deduction, you MUST explicitly signal this transition. Use clear markers like "**Analysis:**", "**Inference:**", or "Based on the above evidence, it can be reasoned that...". The user must always know what is documented fact versus what is your interpretation.

- **Intellectual Honesty:** If the documents are silent on a topic, say so explicitly. If evidence is contradictory, present both sides. If evidence is weak or limited, acknowledge the limitation. Never fabricate, extrapolate beyond what sources say, or fill gaps with assumptions presented as facts.

- **Thoroughness by Default:** Complete ALL planned iterations. Do not prematurely conclude that you have "enough" evidence. Continue exploring and discovering until the final iteration.

---

# Core Principles

## Research Principles

- **Explore until the end:** Every iteration should actively search for new information. Do not coast through later iterations.
- **Follow every lead:** When documents reference other topics, people, events, or documents, pursue those leads.
- **Vary your approach:** Use different search strategies, terminology, and angles throughout all iterations.
- **Collect exhaustively:** Gather more evidence than you think you need. It's better to have too much than too little.

## Analysis Principles

- **Ground everything in evidence:** Every analytical point must connect to specific excerpts from documents.
- **Show your reasoning:** When you draw conclusions, explain the logical steps from evidence to conclusion.
- **Acknowledge uncertainty:** Clearly state when evidence is limited, conflicting, or inconclusive.
- **Distinguish levels of confidence:** Some findings are well-supported by multiple sources; others rest on single mentions.

## Report Principles

- **Excerpts are mandatory:** Every finding MUST include direct quotes from source documents. Summaries without excerpts are not acceptable.
- **Verifiability is paramount:** The user must be able to verify every claim by checking the cited source and excerpt.
- **Detail over brevity:** Err on the side of including more information. Provide context, background, and related details.
- **Rich documentation:** Include document paths, section references, and enough context for the user to locate the original.

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
- Explore specific aspects in depth
- Build detailed understanding of key topics
- Pursue references and leads found in documents

## Phase 3: Continued Exploration (Iteration 5+)

Continue exploring with refined focus based on what you've learned.

**Purpose:** Pursue new angles, explore related topics, and ensure comprehensive coverage.

**Characteristics:**
- Explore aspects that emerged from earlier iterations
- Search for additional perspectives and related information
- Pursue leads and references found in documents
- Investigate connections between findings
- Continue discovering new relevant content until the final iteration

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

**CRITICAL: Steps must be executed SEQUENTIALLY, not in parallel.**

Each iteration follows a strict sequence. Do NOT run document reads in parallel with searches. Complete each step before moving to the next.

```
STEP 1: FORMULATE (prepare queries)
   - Create ~5 different search queries
   - Vary terminology (synonyms, formal/informal terms)
   - Vary angles (different aspects of the same topic)
   - Use findings from previous iterations to refine queries

STEP 2: SEARCH (run searches in parallel)
   - Run the 5 searches in parallel
   - Mix strategies: 2-3 hybrid, 1-2 semantic, 1 keyword
   - Use limit: 100 for comprehensive results
   ⏸️ WAIT for all search results before proceeding

STEP 3: ANALYZE RESULTS (review what you found)
   - Review search results
   - Identify promising documents that need full retrieval
   - Note document IDs for the next step
   ⏸️ DO NOT start next iteration yet

STEP 4: READ DOCUMENTS (MANDATORY - sequential)
   ⚠️ THIS STEP IS NOT OPTIONAL
   - Retrieve full documents using document_id parameter
   - Read them ONE BY ONE, not in parallel with searches
   - Extract substantial excerpts for the report
   - If a read fails: FIX THE PARAMETERS AND RETRY
   - NEVER skip reading because of a failed attempt

STEP 5: REFLECT (after reading is complete)
   - What facts did I learn? (with excerpts)
   - What gaps remain in my understanding?
   - What new search terms or angles emerged?
   - What should the next iteration explore?

STEP 6: NEXT ITERATION
   - Only now proceed to the next iteration
   - Start again from STEP 1 with refined queries
```

## Document Reading Rules

**Reading documents is MANDATORY. You cannot produce a quality report without reading the source documents.**

1. **Never skip reading:** If you found relevant documents in search, you MUST read them.

2. **Sequential, not parallel:** Read documents AFTER searches complete, not alongside them.

3. **Retry on failure:** If `knowledge_search` with `document_id` fails:
   - Check the error message
   - Verify the document_id is correct
   - Try again with correct parameters
   - Do NOT give up and skip the document

4. **No excuses:** "I couldn't read the document" is not acceptable. Either:
   - Fix the issue and read it, OR
   - Explain specifically why reading failed after multiple attempts

5. **Extract excerpts:** When you read a document, extract the relevant excerpts immediately. You need these for the report.

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
3. Iteration 3 - Deep dive into [specific aspect 1]
4. Iteration 4 - Deep dive into [specific aspect 2]
5. Iteration 5 - Explore related topics and connections
6. Iteration 6 - Pursue remaining leads and angles
7. Iteration 7 - Final exploration sweep
8. Write detailed report with excerpts
```

*Option B: By phase/objective*
```
1. [Phase 1] Identify key documents and terminology
2. [Phase 1] Map information landscape
3. [Phase 2] Investigate: [specific aspect 1]
4. [Phase 2] Investigate: [specific aspect 2]
5. [Phase 2] Investigate: [specific aspect 3]
6. [Phase 3] Explore connections and related topics
7. [Phase 3] Pursue additional leads
8. Synthesize and write detailed report
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

**Remember: Reports must be detailed and verifiable. Every finding needs excerpts.**

```markdown
# [Title]
*Generated: YYYY-MM-DD*

## Executive Summary
[250-400 words summarizing key findings with citations and brief excerpts]

## Methodology
- Research iterations: [X]
- Documents analyzed: [Y]
- Key search terms: [list]
- Search strategies used: [hybrid/semantic/keyword]

## Findings

> **Note: All statements in this section are documented facts with citations
> and direct excerpts. The user must be able to verify each claim.**

### [Topic/Finding 1]

**Source:** [Document name] [1]

The document explicitly states:
> "[Direct quote - include substantial excerpt, not just a phrase]" [1, Section X]

**Context:** [Explain where this appears in the document and surrounding context]

**Additional evidence:**
> "[Another relevant excerpt from same or different source]" [1] or [2]

Key documented points:
- [Specific point with excerpt]: "[quote]" [1]
- [Specific point with excerpt]: "[quote]" [2]

### [Topic/Finding 2]

**Source:** [Document name] [2]

> "[Substantial excerpt that supports the finding]" [2]

[Continue with detailed, cited evidence for each finding...]

---

## Analysis

> **Important: This section contains interpretation and reasoning based on
> the evidence above. These are NOT documented facts.**

### Interpretation of Findings
[Your analysis, explaining reasoning step by step]

Based on the evidence that "[excerpt]" [1] and "[excerpt]" [2], it can be
reasoned that...

### Connections and Patterns
[Analysis of how different findings relate]

### Implications
[What the findings suggest, clearly marked as inference]

---

## Limitations and Gaps
- The documents do not address [topic]
- Evidence for [aspect] is limited to single source
- [Other gaps with specific detail]

## Conclusions
[Detailed summary based on documented evidence, with key excerpts reiterated]

## References
[1] path/to/file.pdf (doc_xxx) - [Detailed description of document content]
[2] path/to/another.docx (doc_xxx) - [Detailed description of document content]
```

---

## Template: Narrative Timeline

Use for: Chronological reconstructions, event sequences, historical analysis, evolution of topics over time.

**Note:** This is a suggested structure. Adapt it freely to fit your topic and the user's needs - add sections, change the organization, include more detail where relevant, and adjust the format to best tell the story of how events unfolded.

```markdown
# [Descriptive Title]: Timeline of [Subject]

[Opening paragraph explaining what this timeline covers and why it matters.
Provide context for the reader about the scope and significance of the events.]

---

### **[Year] – [Descriptive Period Title]**

[Narrative introduction for this period - 1-2 sentences explaining what was
happening during this time and how it fits into the overall evolution.]

*   **[Document Title/Name] (document_id)**
    *   **Summary:** [Plain language explanation of what this document says
        and its significance in the timeline]
    *   **Evidence:**
        > "[Substantial direct quote from the document that supports the
        summary. Include enough context for the reader to understand.]"

*   **[Another Document] (document_id)**
    *   **Summary:** [What this document contributes to the timeline]
    *   **Evidence:**
        > "[Direct quote with sufficient context]"

---

### **[Next Year] – [Descriptive Period Title]**

[Narrative introduction explaining how the situation evolved from the
previous period. What changed? What new developments occurred?]

*   **[Document Title] (document_id)**
    *   **Summary:** [Explanation]
    *   **Evidence:**
        > "[Quote]"

[Continue pattern for each significant period...]

---

### **[Most Recent Year] – [Descriptive Period Title]**

[Narrative explaining the current state or most recent developments.]

*   **[Document Title] (document_id)**
    *   **Summary:** [Explanation]
    *   **Evidence:**
        > "[Quote]"

---

## Analysis

> **Important: The following is interpretation, not documented fact.**

### Evolution and Patterns
[Analysis of how the subject evolved across the documented periods]

### Key Turning Points
[Identification of significant moments that changed the trajectory]

### Current State and Implications
[Where things stand now based on the documented evidence]

---

## Timeline Gaps
- No documentation found for period [X] to [Y]
- [Other gaps or limitations in the evidence]

## References
[1] path/to/file.pdf (doc_xxx) - [Description of document]
[2] path/to/another.pdf (doc_xxx) - [Description of document]
```

**Key elements of an effective timeline:**
- **Descriptive period titles** - Not just "2020" but "2020 – Focus on Governance and Risks"
- **Narrative flow** - Each period intro explains the evolution
- **Summary + Evidence format** - Plain language summary followed by verifiable quote
- **Shows progression** - Reader can follow how the topic evolved over time

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
   - BAD: "I found some results in iteration 3, that's probably enough"
   - GOOD: Complete ALL 7+ iterations - continue exploring until the final iteration

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

8. **Write reports without excerpts**
   - BAD: "The document discusses authentication issues [1]"
   - GOOD: "The document states: 'Authentication tokens were not properly validated, allowing unauthorized access' [1, Section 3.2]"

9. **Be too brief**
   - BAD: A few sentences per finding
   - GOOD: Detailed findings with context, multiple excerpts, and thorough explanation

10. **Run reads in parallel with searches**
    - BAD: Starting next search iteration while still reading documents
    - GOOD: Complete ALL reads, extract excerpts, THEN start next iteration

11. **Skip reading after a failed attempt**
    - BAD: "The read failed, I'll just summarize from the search snippet"
    - GOOD: Fix the parameters, retry the read, get the full document

12. **Give up on document retrieval**
    - BAD: "I couldn't access the document" (and move on)
    - GOOD: Troubleshoot the issue, retry with correct document_id, persist until successful

---

# Quick Reference

```
DEFAULTS   → 7 iterations minimum, 5 searches/iteration, limit: 100
SEQUENCE   → Search → Wait → Read documents → Analyze → THEN next iteration
READING    → MANDATORY. Never skip. Retry on failure. No excuses.
CLARIFY    → Only genuine ambiguities, 1-2 questions max
TRACK      → Use write_todos for complex investigations (7+ iterations)
ITERATE    → Complete ALL planned iterations - no autonomous early stopping
EXCERPTS   → Every finding MUST include direct quotes from sources
SEPARATE   → Facts (with citations) vs. Analysis (clearly marked)
CITE       → [n] path/file.ext (doc_id) + excerpt
CONTEXT    → If needed, forget old iterations but KEEP LAST 2
TEMPLATES  → Suggestions only - adapt to fit the research
USER       → If user requests more iterations, follow their instructions
```

**Phase progression:**
- Wide (1-2): cap_then_fill, varied queries, map the landscape
- Deep (3-4): score_penalty, follow leads, retrieve full documents
- Explore (5+): pursue new angles, connections, and related topics

**Save reports to:** `reports/{topic-slug}-{YYYY-MM-DD}.md`

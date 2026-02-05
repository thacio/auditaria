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
| **Search limit** | 75 | Results per search (`limit: 75`) |
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

- **Reports must be VERBOSE:** Do not summarize briefly. Write detailed, comprehensive reports with extensive excerpts, context, and explanation. A good report is long and thorough, not short and concise.
- **Excerpts are mandatory:** Every finding MUST include direct quotes from source documents. Summaries without excerpts are not acceptable.
- **Verifiability is paramount:** The user must be able to verify every claim by checking the cited source and excerpt.
- **Detail over brevity:** Always err on the side of including MORE information. Provide context, background, related details, and multiple excerpts per finding.
- **Rich documentation:** Include document paths, section references, and enough context for the user to locate the original.
- **Never be brief:** Short reports are bad reports. The user wants comprehensive coverage, not a quick summary.

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
  strategy: "hybrid",  // Also use semantic AND keyword in wide phase
  limit: 75,
  diversity_strategy: "cap_then_fill",
  max_per_document: 3
})
```

**IMPORTANT - Use ALL three strategies in wide phase:**
- 2 hybrid searches (balanced)
- 2 semantic searches (conceptual)
- 1 keyword search (exact terms, jargon, identifiers)

**Characteristics:**
- Use varied terminology and synonyms
- **MUST use all three search strategies** (hybrid, semantic, AND keyword)
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
  limit: 75,
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

## Iteration vs. Phases - IMPORTANT DISTINCTION

**ITERATION** = One complete research cycle (Iteration 1/7, Iteration 2/7, etc.)
**PHASE** = A step within a single iteration (7 phases: A through G)

Do NOT confuse these. You complete all PHASES within one ITERATION before moving to the next ITERATION.

```
ITERATION 1/7
  └── Phase A: Plan (select objective, formulate queries)
  └── Phase B: Search (execute 5 searches, limit 75)
  └── Phase C: Read (review results, read documents)
  └── Phase D: Clarify (optional - internet only: google_search/web_fetch)
  └── Phase E: Analyze (extract evidence, key findings)
  └── Phase F: Iteration Report (MANDATORY - write to FILE)
  └── Phase G: Reflect & Adapt (evaluate progress, plan next)

ITERATION 2/7
  └── ... same phases ...

ITERATION 4/7
  └── ... same phases ...
  └── 🧹 CONTEXT MANAGEMENT after Phase G (forget iterations 1-2 raw search results)

ITERATION 6/7
  └── ... same phases ...
  └── 🧹 CONTEXT MANAGEMENT after Phase G (forget iterations 3-4 raw search results)

... and so on
```

---

## Phases Within Each Iteration

**You MUST announce what you are doing at each phase for accountability.**

Each iteration has 7 phases. Complete them in order: A → B → C → D → E → F → G

---

### Phase A: PLAN (Select objective, formulate queries)

📢 **Announce:** "**Iteration X/7 - Phase A: Planning**"

**What to do:**
1. **Select objective:** Which aspect of the research question will this iteration address?
2. **Formulate queries:** Create 5 diverse query variations (synonyms, different angles, different phrasings)
3. **Choose strategies:** Decide which search modes to use (hybrid, semantic, keyword)

📢 **State:** "This iteration will focus on: [objective]. Queries planned: [list 5 queries with strategies]"

**Rules:**
- Connect this iteration to your overall research plan
- In early iterations (1-2): focus on wide exploration
- In later iterations (3+): focus on specific leads from previous findings
- Use terminology discovered in previous iterations

⏸️ **WAIT** - finalize your plan before proceeding to Phase B.

---

### Phase B: SEARCH (Execute 5 searches - MANDATORY)

📢 **Announce:** "**Iteration X/7 - Phase B: Searching**"
📢 **State:** "Executing 5 searches for: [objective]"

**Rules:**
- ALWAYS run exactly 5 searches in parallel
- Never do fewer than 5 searches
- Use limit: 75 for all searches
- Use the queries formulated in Phase A

**Strategy mix depends on iteration:**

*Wide iterations (1-2):* Use ALL three strategies
```
Search 1: [query] - hybrid
Search 2: [query] - hybrid
Search 3: [query] - semantic
Search 4: [query] - semantic
Search 5: [query] - keyword   ← REQUIRED in wide phase
```

*Deep iterations (3+):* Focus on what works best
```
Search 1: [query] - hybrid
Search 2: [query] - hybrid
Search 3: [query] - semantic/keyword
Search 4: [query] - semantic
Search 5: [query] - keyword (if exact terms needed; if you identified patterns on the searchs, it might be really usefull)
```

⏸️ **WAIT** for all 5 search results before proceeding to Phase C.

---

### Phase C: READ (Review results, read documents - MANDATORY)

📢 **Announce:** "**Iteration X/7 - Phase C: Reading Documents**"
📢 **State:** "Found X relevant results. Selecting documents to read: [list with reasons]"

**What to do:**
1. **Review snippets:** Scan search results to identify relevant documents
2. **Select documents:** Choose which documents to read in full (use `document_id`)
3. **Read documents:** Retrieve and read each selected document
4. **Extract excerpts:** Copy substantial quotes that are relevant to the research

**Rules:**
- Read documents ONE BY ONE (not in parallel with searches)
- Extract substantial excerpts immediately - you need these for the report
- If a read fails: FIX PARAMETERS AND RETRY
- NEVER skip reading - this is where you get the evidence

⏸️ **WAIT** until all reading is complete before proceeding to Phase D.

---

### Phase D: CLARIFY (Optional - internet only)

📢 **Announce:** "**Iteration X/7 - Phase D: Clarification**" (if needed)

**When to use this phase:**
- A term, acronym, or concept needs external definition
- You need external context to interpret findings
- A referenced standard, law, or specification needs explanation
- You want to verify a public fact (dates, regulations, read laws, understand conecpts, etc.)

**Use internet tools only**:

- `google_search` - for definitions, context, or verification
- `web_fetch` - to read official documentation, standards, regulations

**Examples:**
```
google_search({ query: "[technical term] definition" })
google_search({ query: "[regulation name] requirements" })
web_fetch({ url: "https://official-source.com/standard", prompt: "Extract the definition of X" })
```

**If not needed:** Skip to Phase E. Not every iteration needs clarification.

---

### Phase E: ANALYZE (Extract evidence, key findings - MANDATORY)

📢 **Announce:** "**Iteration X/7 - Phase E: Analyzing Findings**"

**What to do:**
1. **Organize evidence:** Group excerpts by theme or relevance to research question
2. **Identify key findings:** What are the most important facts discovered?
3. **Note connections:** How do these findings relate to previous iterations?
4. **Spot patterns:** Are themes or patterns emerging across documents?
5. **Flag uncertainties:** What remains unclear or contradictory?

📢 **State:** "Key findings from this iteration: [brief summary of 2-3 main discoveries]"

**Rules:**
- Ground every finding in specific excerpts from documents
- Distinguish facts (documented) from inferences (your interpretation)
- Note which findings are well-supported vs. single-source
- Identify gaps that need further investigation

⏸️ **WAIT** - complete your analysis before proceeding to Phase F.

---

### Phase F: ITERATION REPORT (MANDATORY - WRITE TO FILE)

📢 **Announce:** "**Iteration X/7 - Phase F: Writing Iteration Report to File**"

⚠️ **THIS PHASE IS MANDATORY. DO NOT SKIP IT.**

**Write the iteration report to a file** (not inline). This forces detailed documentation and saves context space.

**File:** `reports/{topic-slug}-iteration-reports.md`

⚠️ **CRITICAL: APPEND, DO NOT OVERWRITE**

Each iteration's report must be ADDED to the file, preserving ALL previous iterations. The file should grow with each iteration, containing the complete research history.

**How to append correctly:**

- **Iteration 1** (file doesn't exist yet): Use `write_file` to create the file with the first report.
- **Iteration 2+** (file already exists): Use the `replace` (edit) tool to append. Match the last `---` separator at the end of the file and replace it with that separator plus the new iteration report. This way the existing content is untouched.

  Example using the edit tool:
  ```
  old_string: (the last few lines of the file, ending with the final ---)
  new_string: (those same lines, plus the new iteration report appended after)
  ```

⛔ **NEVER use `write_file` on an existing iteration report file** — it overwrites the entire file, destroying all previous iterations.

**Append the following structure to the file:**

```markdown
## Iteration X/7 Report

### Objective
[What this iteration aimed to discover/investigate]

### Searches Performed
| # | Query | Strategy | Results |
|---|-------|----------|---------|
| 1 | "[query]" | hybrid | X |
| 2 | "[query]" | hybrid | X |
| 3 | "[query]" | semantic | X |
| 4 | "[query]" | semantic | X |
| 5 | "[query]" | keyword | X |

### Documents Read
| Document | Path (doc_id) | Why Selected |
|----------|---------------|--------------|
| [Name] | path/to/doc (doc_id) | [Reason] |

### Clarifications (if any)
[Internet searches performed in Phase D]

### Key Excerpts
**[Document 1]:**
> "[Substantial excerpt]"

**[Document 2]:**
> "[Substantial excerpt]"

### Analysis
[What findings mean for research question, patterns emerging, connections to previous iterations]

### Gaps
[What remains unclear, next focus areas]

---
```

⏸️ **WAIT** - file must be written before proceeding to Phase G.

---

### Phase G: REFLECT & ADAPT (Evaluate progress, plan next iteration)

📢 **Announce:** "**Iteration X/7 - Phase G: Reflecting and Adapting**"

**What to do:**
1. **Evaluate search performance:** Did the search strategies work well? What new terms emerged?
2. **Assess progress:** How much of the research question has been addressed?
3. **Identify next steps:** What should the next iteration focus on?
4. **Adapt strategy:** Should you go wider (new angles) or deeper (specific follow-ups)?

📢 **State:** "Progress assessment: [brief status]. Next iteration will focus on: [specific objective]"

**Reflection questions:**
- Which research plan objectives have been addressed?
- What information gaps still need attention?
- What new keywords/terms emerged for future searches?
- Should the next iteration explore new territory or dig deeper into promising leads?

**Update your TODO list** (if using write_todos) to reflect progress and next steps.

---

### Move to Next Iteration

📢 **Announce:** "**Completed Iteration X/7. Moving to Iteration X+1/7**"

Only after completing ALL phases (A through G) do you proceed to the next iteration.

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

# Internet Search (Phase D: Clarify)

Phase D uses internet tools (`google_search`, `web_fetch`) for external context. Use sparingly.

## When to Use (Phase D)

- **Unfamiliar terms** - Legal jargon, technical acronyms, industry concepts
- **Referenced standards** - ISO, RFCs, legal codes, frameworks
- **Verify public facts** - Dates, regulations, company information
- **Official sources** - Laws, standards, specifications cited in documents

## When NOT to Use

- Every unfamiliar term (too slow)
- When KB documents already explain it
- Facts you're confident about

## Citation Distinction

Distinguish internet sources from knowledge base sources:

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

Context management is **mandatory** to prevent context explosion during research.

## When to Run Context Management

**Schedule:** Starting at iteration 4, then every 2 iterations.

| After Iteration | Action |
|-----------------|--------|
| 4 | Forget iterations 1-2 raw search results |
| 6 | Forget iterations 3-4 raw search results |
| 8 | Forget iterations 5-6 raw search results |

## What Can Be Forgotten

**ONLY forget raw search results from Phase B.** Everything else must be preserved.

| Phase | Content | Forget? |
|-------|---------|---------|
| A: Plan | Objective, queries | ❌ NO |
| **B: Search** | **Raw search results** | ✅ YES |
| C: Read | Document excerpts | ❌ NO |
| D: Clarify | Internet lookups | ❌ NO |
| E: Analyze | Analysis notes | ❌ NO |
| F: Report | **Iteration Report (in file)** | ❌ NO - this is your record |
| G: Reflect | Reflection notes | ❌ NO |

**The Iteration Report file preserves everything important.** Raw search results become redundant once documented.

## How to Run Context Management

```
1. After iteration 4 (and every 2 iterations after):
   context_management({ action: "inspect" })

2. Identify ONLY Phase B raw search results from OLD iterations (not last 2)

   ⚠️ CRITICAL DISTINCTION:
   - ✅ FORGET: knowledge_search with `query` parameter (Phase B search results)
   - ❌ KEEP: knowledge_search with `document_id` parameter (Phase C document reads)

   Look for tool calls like:
   - FORGET: knowledge_search({ query: "...", strategy: "..." }) → These are Phase B
   - KEEP: knowledge_search({ document_id: "doc_xxx" }) → These are Phase C reads

3. Forget ONLY Phase B search results with summary:
   context_management({
     action: "forget",
     ids: [phase_b_search_result_ids_only],
     summary: "Phase B search results from iterations 1-2. Key docs and excerpts preserved in iteration report file."
   })
```

**Keep the last 2 iterations' raw results** for continuity.

**NEVER forget Phase C document reads** - these contain the actual excerpts and evidence you need for the report.

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

  // Results (default: 30, use 75 for research)
  limit: 75,

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

**IMPORTANT: Reports must be VERBOSE and COMPREHENSIVE.** Do not write short, concise summaries. Write detailed, thorough reports with:
- Multiple excerpts per finding
- Extensive context and background
- Detailed explanations
- Rich documentation

A good research report is LONG. Brief reports fail to capture the depth of research conducted.

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
   - GOOD: `limit: 75` (balanced coverage and context)

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
   - BAD: A few sentences per finding, short summaries, concise reports
   - GOOD: VERBOSE reports with detailed findings, extensive context, multiple excerpts per finding, thorough explanation. A report should be LONG.

10. **Run reads in parallel with searches**
    - BAD: Starting next search iteration while still reading documents
    - GOOD: Complete ALL reads, extract excerpts, THEN start next iteration

11. **Skip reading after a failed attempt**
    - BAD: "The read failed, I'll just summarize from the search snippet"
    - GOOD: Fix the parameters, retry the read, get the full document

12. **Give up on document retrieval**
    - BAD: "I couldn't access the document" (and move on)
    - GOOD: Troubleshoot the issue, retry with correct document_id, persist until successful

13. **Work silently without announcing progress**
    - BAD: Just running searches and reads without telling the user what you're doing
    - GOOD: "**Iteration 3/7 - Phase B: Reading Documents** Found 4 relevant docs..."

14. **Do fewer than 5 searches per iteration**
    - BAD: Running 1-3 searches and moving on
    - GOOD: ALWAYS run exactly 5 searches in Phase B of every iteration

15. **Skip the Analysis phase (Phase E)**
    - BAD: Search → Read → immediately start next iteration
    - GOOD: Plan → Search → Read → Clarify → ANALYZE → Report → Reflect → then next iteration

16. **Confuse iterations with phases**
    - BAD: Treating phases as iterations or vice versa
    - GOOD: Iteration 3/7 contains Phases A-G. Complete all 7 phases before Iteration 4/7.

17. **Skip the Iteration Report (Phase F)**
    - BAD: Doing analysis mentally and moving on without documenting
    - GOOD: Write the full iteration report with searches, docs, excerpts, and analysis

18. **Overwrite iteration reports instead of appending**
    - BAD: Using `write_file` on an existing report — it overwrites everything, destroying previous iterations
    - GOOD: Use `replace` (edit) tool to append — match the end of the file and add the new iteration after it

19. **Forget Phase C document reads along with Phase B search results**
    - BAD: Forgetting all `knowledge_search` results including document reads
    - GOOD: ONLY forget `knowledge_search` with `query` (Phase B). KEEP `knowledge_search` with `document_id` (Phase C reads)

---

# Quick Reference

```
ITERATIONS → 7 minimum. Each iteration has 7 phases (A through G)
PHASES     → A: Plan → B: Search (5) → C: Read → D: Clarify → E: Analyze → F: Report → G: Reflect
LIMIT      → 75 results per search
SEARCHES   → ALWAYS 5 searches per iteration. Wide (1-2): use ALL 3 strategies including keyword
PLAN       → Phase A: Select objective, formulate 5 queries, choose strategies
READ       → Phase C: Review results, read full documents, extract excerpts
CLARIFY    → Phase D: Optional - INTERNET ONLY (google_search/web_fetch)
ANALYZE    → Phase E: Organize evidence, identify key findings, spot patterns
REPORT     → Phase F: Write to FILE (reports/{topic}-iteration-reports.md) - MANDATORY
REFLECT    → Phase G: Evaluate progress, adapt strategy, plan next iteration
ANNOUNCE   → State "Iteration X/7 - Phase Y" at each step
READING    → MANDATORY. Never skip. Retry on failure. No excuses.
CONTEXT    → Run at iteration 4, then every 2 iterations. Forget Phase B raw results only.
ITERATE    → Complete ALL iterations - no early stopping
VERBOSE    → Reports must be detailed and comprehensive, NEVER brief
EXCERPTS   → Every finding MUST include direct quotes from sources
SEPARATE   → Facts (with citations) vs. Analysis (clearly marked)
CITE       → [n] path/file.ext (doc_id) + excerpt
USER       → Follow user's instructions on iteration count
```

**Phase progression:**
- Wide (1-2): cap_then_fill, ALL 3 strategies (hybrid + semantic + keyword)
- Deep (3-4): score_penalty, follow leads, retrieve full documents
- Explore (5+): pursue new angles, connections, and related topics

**Save final report to:** `reports/{topic-slug}-{YYYY-MM-DD}.md`
**Save iteration reports to:** `reports/{topic-slug}-iteration-reports.md`

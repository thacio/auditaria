---
name: artifact-design
description:
  Design guidance for pages published with the artifact tool. Load it before
  writing any artifact page — it calibrates the visual treatment to the
  request, fixes the theme, typography, layout and copy rules the host
  expects, and sets the write-once-look-once-publish rhythm.
---

# Artifact design

Approach this as the design lead at a small studio known for versatility:
every page gets a visual identity pitched at the treatment the task
actually calls for, with deliberate palette, typography and layout choices
specific to its subject, never a template.

## Read the request first

Calibrate the treatment, not whether to design. A memo deserves the same
craft as a landing page; what changes is the treatment. Author HTML;
publish Markdown only when a loaded skill explicitly instructs it (a
Markdown page keeps its file name as its title and takes almost none of the
craft below — it is never a way to save time).

Many requests want a utilitarian treatment: a plan, a memo, an audit
finding, a demo. Make it polished — real typographic hierarchy, considered
spacing, a proper palette — but do not over-design; most pages need no
flashy hero. Some requests want an editorial treatment: a landing page, a
game, a tool the user will keep. When unsure, a well-composed page is never
wrong; an over-designed identity sometimes is.

## Fundamentals for every artifact

**Honor what is already there.** Look for a design system first: a CLAUDE.md
or AUDITARIA.md `## Design system` section, a tokens or theme file, existing
component styles, and — for a page meant to sit inside the Auditaria
console — the console's own tokens in `packages/web-client/src/styles/themes.css`.
Precedence: the user's words, then the project's system, then your choices.

**Ground it in the subject.** Pin one concrete subject, its audience, and
the page's single job. The subject's own world (its materials, units,
document conventions, terms of art) is where distinctive choices come
from. Carry at least one detail only this subject would have, as content,
not ornament. Real content throughout, never lorem ipsum.

**Pair typefaces.** Typography carries the page. Google Fonts is the one
font host the artifact CSP admits — link it directly
(`<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=...&display=swap">`);
any other face must be inlined as a `@font-face` data URI or it falls back
silently. Always declare a real fallback stack. Keep running text near 65
characters wide, set a type scale and stay on it, give headings
`text-wrap: balance`, and uppercase labels a touch of letter-spacing.

**Load libraries, don't paste them.** When a page genuinely needs a
library (React, a chart or highlighting package), load its UMD build from
cdnjs with one pinned `<script src="https://cdnjs.cloudflare.com/ajax/libs/...">`
placed before the inline script that uses its global. Only scripts may
come from the allowed hosts (cdnjs, jsDelivr `/npm/`, the Tailwind play
CDN, jQuery); a library's stylesheet must be inlined. Most pages need no
library at all. When `AUDITARIA_ARTIFACT_CDN=0` is set the host serves
fully offline — inline everything.

**Choose neutrals, don't default to them.** A pure mid-grey reads as
unconsidered; a grey with a slight bias toward the accent reads as chosen.

**Design both themes.** The page renders in the viewer's theme, which has
three states: an explicit choice stamps `data-theme="dark"` or
`data-theme="light"` on the root element, and the default "system" setting
stamps nothing. Structure the CSS token-first for all three: the bare
`:root` block defines the complete light palette; `@media
(prefers-color-scheme: dark)` redefines only the tokens, guarded as
`:root:not([data-theme="light"])`; `:root[data-theme="dark"]` redefines them
again so the toggle wins in both directions. Style components through the
tokens, never directly inside a media or `[data-theme]` block. Give `body`
an explicit background from a token — the host paints its own ground behind
the page. Give the second theme the same care as the first. A design that
deliberately commits to one look may stay single-theme, but still paints
every color explicitly.

**Let layout do the spacing.** Flex or grid with `gap`, not per-element
margins. Wide content (tables, code, diagrams) gets `overflow-x: auto` on
its own container so the page body never scrolls sideways. Use
`font-variant-numeric: tabular-nums` wherever digits line up.

**Compose repeated things as one object.** Cards in a row, label/value
pairs, badges on siblings: same edges, baselines and padding from one to
the next. Not everything is a card — spend border, fill, radius and shadow
by role.

**Draw charts to the scale.** One scale places marks and labels; every label
names a value the chart reaches; chart text takes its color from the theme
tokens; marks stay inside the drawing's bounds.

**Show the page at rest.** Everything meant to be read is visible once the
page loads, without scrolling to trigger it. No `opacity: 0` waiting on an
observer, no `100vh` opener. A tool opens in a realistic working state with
real data, or example rows plainly marked as examples.

**Avoid the generated look.** Warm cream with a serif display and a
terracotta accent; near-black with a lone acid-green pop; a purple-to-blue
gradient hero on white; Inter or Space Grotesk as the "safe" face; emoji as
section markers; everything centered; rounded cards with accent rails
everywhere. Follow the user's direction exactly when they name one; where
nothing is specified, do not spend that freedom on these defaults.

**Build cleanly.** Close every non-void element, double-quote attributes,
give keyboard focus a visible state, respect `prefers-reduced-motion`, watch
selector specificity so spacing is not silently undone. Reach for Canvas or
WebGL for generative graphics rather than long hand-authored SVG paths.

**Write the copy from the user's side of the screen.** Name things by what
people recognize, active voice, a control says exactly what happens, an
error says what went wrong and how to fix it.

**Name the page like a product.** The `<title>` (in the first 8 KB) is the
artifact's name in the gallery and the browser tab: a short noun phrase,
typically two to four words, specific to the subject — never a generic
category label, never a name plus an explainer after a dash or colon. The
one-sentence publish `description` is where the explanation belongs; the
gallery shows it under the title.

**Structure is information.** Numbering, eyebrows, dividers and labels
should encode something true about the content. Numbered markers belong
only to real sequences.

**When it is a UI, not a document.** A dashboard is scanned and operated:
surface the summary before the detail, encode state in form as well as
number (a pill, a chip, a severity stripe), keep semantic color (good /
warning / critical) separate from the accent, and make what is interactive
look interactive.

## Process

Start with what the viewer should be able to *do* on the page. If it
should take input, keep what people change, show live data or ask the
model, load the `artifact-capabilities` skill now and design around what it
makes available.

Before writing code, sketch a short design plan: 4–6 named hex colors, two
or more type roles (a characterful display face used with restraint, a
complementary body face, a utility face for data if needed), and a layout
concept in one or two sentences. Then build from it, deriving every color
and type decision from the plan.

**Write, look once, publish.** Before publishing you may look at the
rendered page once — the artifact URL after a first publish, or a local
preview — then make one pass of edits for what it shows. Do not build a
test loop around your own file: no repeated screenshots, no DOM probes.
Publish, check once any `claude.use()` call the preview could not run, and
stop: the live page is the review surface. If the user reports something
visibly broken, fix it and republish once.

## When the request is editorial

The client has already rejected proposals that felt templated. Make
opinionated calls and take one real aesthetic risk where it serves the
work. Review the design plan against the subject before building: revise
any part that reads like the generic default for a similar page. The hero
is a thesis (open with the most characteristic thing in the subject's
world); typography carries the personality; motion is deliberate and
orchestrated, never scattered; spend boldness in one place and keep
everything around it quiet.

# Exporting independent HTML

Author the artifact normally. Pin library URLs and keep related files local or
attached. Exporting downloads public HTTPS dependencies on the author's
computer; readers receive the code, CSS, fonts, images and selected data inside
one HTML. It does not publish, grant access or alter the source artifact.

## Agent workflow

Call the existing `artifact` tool:

```json
{
  "action": "export",
  "url": "<artifact-id>",
  "target": "sharepoint",
  "compression": "lossless",
  "dry_run": true
}
```

Use `file_path` instead of `url` for an HTML/Markdown file or directory
containing `index.html`. Stored exports use the served/pinned version unless
`version` is specified. A historical version's attached files reflect the files
available at export time, recorded by hash; they are not a historical database
snapshot.

Read the diagnostic report. Resolve essential missing dependencies or adapt
unsupported behavior, then repeat with `dry_run:false` and optional `out_dir`.
`needs_adaptation` produces a report instead of an HTML claimed to work. A
`ready` conversion still needs a functional check in its intended destination;
it is not a browser certification.

Keep hosted and exported resource loading distinct. `window.__auditariaExport`
is injected into the exported copy, not the normal hosted page. Export-only
resource mappings do not attach files to the hosted artifact. For hosted use,
include dependencies in the published site or use attached asset URLs. Preserve
dependencies needed by older versions; a relative URL in an old tab can resolve
against a changed current site. Check the actual version and resource response
when diagnosing a stale tab or historical view.

Test the final hosted viewer and the actual exported file, not just the
authoring preview. With networking disabled, exercise next/previous steps, tabs,
details, and evidence images, including a representative late-page reference.
Verify readability and zoom as well as successful loading. For failures,
distinguish missing files or HTTP errors, invalid data, unavailable export
runtime, and decompression errors. Mention an unsupported browser API only after
checking that it is actually unavailable; don't use that advice for every caught
error. If compressed data is essential, test its fallback or export with
`compress_data:false` when compatibility requires it. Record which environments
passed; an offline test does not establish SharePoint compatibility.

At handoff, identify the artifact version, provide its link and the final HTML
path, show the size and warnings, and give the user the SharePoint steps below.
Don't leave the entire procedure in an unmentioned generated file. Reuse a
verified export when it already matches the approved version; after changes,
export the new version without overwriting an earlier delivery unless requested.

The user can also use **Export HTML** in the viewer or `/artifacts export <id>`.
The viewer lets them choose the destination, compression and compressed data,
then download HTML, report and SharePoint instructions. Cancellation stops the
request. Keep authoring details out of the exported page except facts readers
need, such as the snapshot date and temporary nature of edits.

## Supported transformations and adaptations

- Inline classic scripts and bundle statically resolvable ESM imports. Keep
  script order. Async loaders, computed imports and import maps need adaptation.
- Incorporate styles, CSS imports with media conditions, images, font URLs and
  common srcset/background references. Complex CSS layer/supports imports are
  diagnosed. A CDN library may still contain network-dependent features: test
  the features used by the page.
- Convert one-argument `fetch("data.json")`/CSV/text/SQLite into an in-memory
  response. Dynamic API calls are not frozen or silently intercepted.
- For explicit data, pass `resources:{"database":"data.sqlite"}` and use
  `await window.__auditariaExport.bytes("database")`, `.text(key)` or
  `.json(key)` in export-specific code. These return memory data, without
  `fetch(data:)`.
- For SQLite use pinned sql.js `sql-asm-memory-growth.js` and pass the byte
  array to `new SQL.Database(bytes)`. The exporter adapts recognized pinned
  jsDelivr sql-wasm loaders to that build; unknown loaders need explicit
  adaptation. Supply a consistent SQLite snapshot, including committed WAL
  changes. Never treat copied bytes as a shared writable database.
- Local iframe documents can become `srcdoc`; verify interactivity. Links to
  separate local pages are diagnosed and do not become a multipage application.
- `claude.use()` returns `null`. Identity, sample/model calls, publishing,
  subscriptions and database writes require the Auditaria server. Provide useful
  fallback behavior or explicitly select a data snapshot. Do not export every
  private database row just because it is technically accessible.

## Size and compression

Default `compression:"lossless"` minifies code/styles without dropping data or
reducing image quality. PNG recompression is retained only when smaller and its
decoded pixels match the original; other image formats retain their bytes.
Embedded data uses gzip when it is smaller and decodes in memory. Use
`compress_data:false` when DecompressionStream is unavailable, or
`compression:"none"` to preserve resources without these transforms.

Show final bytes/MiB, compressed-data savings and the largest resources. The
default warning begins at 5 MiB (`warn_mib` is configurable), with an additional
warning above 16 MiB. These are product guidance, not Microsoft limits. **Do not
refuse export, ask for force, or require another approval solely because it is
large.** The hosted ArtifactStore's separate 16 MiB publish limit still exists.

Base64 adds about one third to binary size; gzip data savings are not savings of
the entire HTML. Suggest fewer font weights, genuinely duplicate resources or
selected PDF pages if useful. Do not discard pages/rows, lower evidence quality,
or replace the artifact with screenshots without a content-specific decision.
ZIP is transport packaging and must be extracted before SharePoint upload.

PDF bytes alone are not a working viewer. PDF/object/embed and media-dependent
features are diagnosed; selected PDF pages can be prepared as images with page
references before export. A full PDF.js viewer, lossy image recompression and
general multipage rewriting are not automatic transformations in this
implementation.

## User instructions for SharePoint

1. Upload the exported HTML to a document library, or save it in a
   OneDrive/Teams folder synced to that library. Verify that the file has
   arrived online.
2. Grant intended readers access to both the HTML file and the containing page.
   Organization links require login and may need to be opened once to redeem
   access. They are not anonymous/public hosting.
3. Obtain the file's actual SharePoint `UniqueId`. In an authenticated site,
   `/_api/web/GetFileByServerRelativeUrl('<server-relative-file-path>')?$select=UniqueId`
   is a read-only metadata route. Encode the path correctly; a sharing token is
   not the GUID. An agent with a logged-in browser can assist.

   Explain the placeholders instead of leaving the user to infer them. The site
   URL is `https://TENANT.sharepoint.com/sites/SITE`; the server-relative file
   path starts with `/sites/SITE/` and includes the library, folders, filename,
   and extension. Ask for the uploaded file's link if these are unknown. From a
   path-bearing sharing link, omit sharing prefixes such as `/:u:/r` and query
   parameters; opaque sharing links require resolving the file first. Give the
   user a filled-in metadata URL, tell them to open it while signed in, and copy
   the `UniqueId` field from the JSON/XML response. Then provide the filled-in
   iframe. Never reuse another file's GUID or present an inferred ID as
   verified.

4. Add an Embed web part on a modern page and use:

```html
<iframe
  src="https://TENANT.sharepoint.com/sites/SITE/_layouts/15/embed.aspx?UniqueId=GUID&amp;nb=true"
  width="100%"
  height="900"
  title="Artifact"
></iframe>
```

5. Save/publish according to the user's intended workflow and test as another
   authorized reader. A thumbnail may require a click to activate the preview.
6. For updates, replace the same file's content and check that its GUID remains
   stable. Deleting/recreating can change the GUID and require a new iframe URL.

The generated `LEIA-ME.md` contains instructions suitable to give the user.
HTTPS and iframe-based embed code are documented by
[Microsoft](https://support.microsoft.com/en-us/sharepoint/sites-pages/add-content-to-your-page-using-the-embed-web-part).
The Embed field does not accept script tags; that is distinct from scripts
inside the previewed HTML. Do not suggest renaming HTML to ASPX as the normal
procedure.

## Observed restrictions, not universal guarantees

Tests on 2026-09-10 in one SharePoint Online tenant accepted initially embedded
scripts, styles/fonts/images, sql.js in memory, manual file selection and gzip
DecompressionStream. They blocked external scripts/styles, fetch even to the
same folder, workers, network iframes, object/embed, localStorage and IndexedDB.
Static iframe srcdoc worked; adding a script dynamically after load was blocked.
The clean embed route and `nb=true` are experimentally verified there, not a
guarantee of identical behavior in every tenant or future Microsoft release.

Do not claim that downloads, clipboard, printing, media or arbitrary WASM/PDF.js
work without testing them. If something fails, distinguish authentication,
permissions, stale sync/GUID, native preview UI and CSP restrictions. An HTML
direct URL can download while its preview URL works. An HTTP 200 can contain a
SharePoint error page, so inspect actual content.

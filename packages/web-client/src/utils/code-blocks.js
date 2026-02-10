/**
 * Code block post-processor — highlight.js integration + language badge + copy button.
 *
 * Call processCodeBlocks(container) after setting innerHTML from marked.parse().
 */

/**
 * Post-process all <pre><code> blocks inside a container:
 * 1. Run highlight.js (if loaded)
 * 2. Inject header with language badge + copy button
 */
export function processCodeBlocks(container) {
  if (!container) return;
  const blocks = container.querySelectorAll('pre > code');

  blocks.forEach((codeEl) => {
    const preEl = codeEl.parentElement;
    if (preEl.classList.contains('code-block-processed')) return;
    preEl.classList.add('code-block-processed');

    // Detect language from class (marked adds "language-xxx")
    const langClass = Array.from(codeEl.classList).find((c) => c.startsWith('language-'));
    const lang = langClass ? langClass.replace('language-', '') : '';

    // Run highlight.js
    if (window.hljs && lang) {
      try {
        const result = window.hljs.highlight(codeEl.textContent, { language: lang, ignoreIllegals: true });
        codeEl.innerHTML = result.value;
        codeEl.classList.add('hljs');
      } catch {
        // Unknown language — try auto-detect
        try {
          const auto = window.hljs.highlightAuto(codeEl.textContent);
          codeEl.innerHTML = auto.value;
          codeEl.classList.add('hljs');
        } catch {}
      }
    } else if (window.hljs && !lang) {
      try {
        const auto = window.hljs.highlightAuto(codeEl.textContent);
        codeEl.innerHTML = auto.value;
        codeEl.classList.add('hljs');
      } catch {}
    }

    // Build header
    const header = document.createElement('div');
    header.className = 'code-block-header';

    // Language badge
    const badge = document.createElement('span');
    badge.className = 'code-block-lang';
    badge.textContent = lang || 'text';
    header.appendChild(badge);

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'code-block-copy';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      const text = codeEl.textContent;
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = 'Copied!';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
          copyBtn.classList.remove('copied');
        }, 2000);
      }).catch(() => {
        // Fallback
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        copyBtn.textContent = 'Copied!';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
          copyBtn.classList.remove('copied');
        }, 2000);
      });
    });
    header.appendChild(copyBtn);

    // Wrap: insert header before <pre>
    preEl.parentNode.insertBefore(header, preEl);

    // Wrap both in a container div
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block-wrapper';
    header.parentNode.insertBefore(wrapper, header);
    wrapper.appendChild(header);
    wrapper.appendChild(preEl);
  });
}

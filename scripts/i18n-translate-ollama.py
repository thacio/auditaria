#!/usr/bin/env python3

"""
I18n Auto-Translation Script (Ollama version)

Uses Gemma 3 model via Ollama for GPU-accelerated translation.

Setup:
    1. Install Ollama from https://ollama.com
    2. Run: ollama pull gemma3:27b
    3. Run this script: python scripts/i18n-translate-ollama.py --lang=pt

Usage:
    python scripts/i18n-translate-ollama.py --lang=pt
    python scripts/i18n-translate-ollama.py --lang=pt --force
    python scripts/i18n-translate-ollama.py --model=gemma3:12b  # smaller model
"""

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional
import requests


def safe_print(text: str) -> None:
    """Print text safely, handling Unicode encoding errors on Windows."""
    try:
        print(text)
    except UnicodeEncodeError:
        safe_text = text.encode('ascii', 'replace').decode('ascii')
        print(safe_text)


# Language configurations
LANGUAGE_CONFIG = {
    'pt': {
        'name': 'Portuguese (Brazilian)',
        'code': 'pt-BR',
        'instructions': 'Use informal "você" form, not "tu". Be concise.',
    },
    'es': {
        'name': 'Spanish',
        'code': 'es',
        'instructions': 'Use informal "tú" form. Be concise.',
    },
    'fr': {
        'name': 'French',
        'code': 'fr',
        'instructions': 'Use informal "tu" form. Be concise.',
    },
    'de': {
        'name': 'German',
        'code': 'de',
        'instructions': 'Use informal "du" form. Be concise.',
    },
}

DEFAULT_MODEL = 'gemma3:27b'
OLLAMA_API_URL = 'http://localhost:11434/api/generate'


def parse_args():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description='Auto-translate i18n strings using Ollama',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument('--lang', '-l', default='pt', help='Target language code')
    parser.add_argument('--input', '-i', default='i18n-pending-translations.json')
    parser.add_argument('--output', '-o', default='i18n-completed-translations.json')
    parser.add_argument('--model', '-m', default=DEFAULT_MODEL, help='Ollama model name')
    parser.add_argument('--resume', '-r', action='store_true', help='Resume from checkpoint')
    parser.add_argument('--checkpoint-interval', type=int, default=10)
    parser.add_argument('--batch-size', '-b', type=int, default=30)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--verbose', '-v', action='store_true')
    parser.add_argument('--force', action='store_true', help='Re-translate all strings')
    return parser.parse_args()


def get_checkpoint_path(output_path: str) -> str:
    return output_path.replace('.json', '.checkpoint.json')


def get_locale_path(lang_code: str) -> Path:
    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    return project_root / "packages" / "core" / "src" / "i18n" / "locales" / f"{lang_code}.json"


def load_existing_translations(lang_code: str) -> Dict[str, str]:
    locale_path = get_locale_path(lang_code)
    if not locale_path.exists():
        return {}
    try:
        with open(locale_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
            return data.get('_exactStrings', {})
    except (json.JSONDecodeError, IOError):
        return {}


def load_json(path: str) -> Optional[Dict]:
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except json.JSONDecodeError as e:
        print(f"Error parsing {path}: {e}")
        return None


def save_json(path: str, data: Dict) -> None:
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def check_ollama_running() -> bool:
    """Check if Ollama is running."""
    try:
        response = requests.get('http://localhost:11434/api/tags', timeout=5)
        return response.status_code == 200
    except requests.exceptions.ConnectionError:
        return False


def build_batch_prompt(items: List[Dict], lang_code: str) -> str:
    """Build a batch translation prompt."""
    lang = LANGUAGE_CONFIG.get(lang_code, {'name': lang_code.upper(), 'instructions': 'Be concise.'})

    strings_list = [f"{i}. {item['key']}" for i, item in enumerate(items, 1)]
    strings_text = "\n".join(strings_list)

    return f"""Translate these UI texts from English to {lang['name']}.

RULES:
- Output ONLY numbered translations, one per line
- Preserve formatting (bullet lists, number lists, roman lists, etc) like the original, for example: "1. original english text" -> "1. translated text"(number, dot, space, translation only). Observe that the numbering list was preserved.
- Keep {{placeholders}} exactly as they appear - do NOT translate them
- Keep slash commands (e.g., /help, /settings) exactly as they appear
- Keep technical terms (API, CLI, JSON, URL, MCP, OAuth) unchanged
- {lang['instructions']}
- NO explanations, NO notes, ONLY translations

Texts:
{strings_text}"""


def parse_batch_response(response: str, count: int) -> List[Optional[str]]:
    """Parse batch translation response."""
    results = [None] * count
    lines = response.strip().split('\n')

    for line in lines:
        line = line.strip()
        if not line:
            continue
        match = re.match(r'^(\d+)\.\s*(.+)$', line)
        if match:
            idx = int(match.group(1)) - 1
            translation = match.group(2).strip()
            # Remove quotes if wrapped
            if (translation.startswith('"') and translation.endswith('"')) or \
               (translation.startswith("'") and translation.endswith("'")):
                translation = translation[1:-1]
            # Remove stray notes
            translation = re.sub(r'\s*\[(?:keep|manter|mantener|garder)[^\]]*\]', '', translation, flags=re.IGNORECASE)
            translation = re.sub(r'^(\d+)\.\s*', '', translation)  # Remove double numbering
            if 0 <= idx < count and translation:
                results[idx] = translation
    return results


def validate_translation(original: str, translation: str, params: List[str]) -> tuple:
    """Validate translation."""
    if not translation or not translation.strip():
        return False, "Empty translation"

    translation = translation.strip()
    if translation.startswith('"') and translation.endswith('"'):
        translation = translation[1:-1]

    for param in params:
        placeholder = f"{{{param}}}"
        if placeholder in original and placeholder not in translation:
            return False, f"Missing parameter: {placeholder}"

    len_ratio = len(translation) / max(len(original), 1)
    if len_ratio > 5 or len_ratio < 0.1:
        return False, f"Suspicious length ratio: {len_ratio:.2f}"

    return True, ""


def translate_with_ollama(prompt: str, model: str, verbose: bool = False) -> Optional[str]:
    """Send translation request to Ollama."""
    try:
        response = requests.post(
            OLLAMA_API_URL,
            json={
                'model': model,
                'prompt': prompt,
                'stream': False,
                'options': {
                    'temperature': 0.3,
                    'top_p': 0.9,
                    'num_predict': 1024,
                }
            },
            timeout=120
        )

        if response.status_code == 200:
            data = response.json()
            return data.get('response', '')
        else:
            print(f"Ollama error: {response.status_code}")
            return None
    except Exception as e:
        print(f"Error calling Ollama: {e}")
        return None


def translate_batch(items: List[Dict], lang_code: str, model: str, verbose: bool = False) -> List[Optional[str]]:
    """Translate a batch of strings."""
    if not items:
        return []

    prompt = build_batch_prompt(items, lang_code)
    if verbose:
        print(f"\n--- Prompt ---\n{prompt}\n--------------")

    response = translate_with_ollama(prompt, model, verbose)
    if not response:
        return [None] * len(items)

    if verbose:
        print(f"Response:\n{response}")

    translations = parse_batch_response(response, len(items))

    # Validate each translation
    results = []
    for i, (item, translation) in enumerate(zip(items, translations)):
        if translation:
            params = item.get('params', [])
            is_valid, error = validate_translation(item['key'], translation, params)
            if is_valid:
                results.append(translation)
            else:
                if verbose:
                    print(f"    Item {i+1} validation failed: {error}")
                results.append(None)
        else:
            results.append(None)

    return results


def translate_single(key: str, context: str, params: List[str], lang_code: str, model: str, verbose: bool = False) -> Optional[str]:
    """Translate a single string (fallback for batch failures)."""
    lang = LANGUAGE_CONFIG.get(lang_code, {'name': lang_code.upper(), 'instructions': 'Be concise.'})

    param_warning = ""
    if params:
        param_list = ", ".join([f"{{{p}}}" for p in params])
        param_warning = f"\nIMPORTANT: Keep these placeholders exactly as-is: {param_list}"

    prompt = f"""Translate this UI text from English to {lang['name']}.

Rules:
- Output ONLY the translation, nothing else
- Keep placeholders like {{name}}, {{count}} UNCHANGED
- Keep slash commands exactly as they appear
- Keep technical terms unchanged
- {lang['instructions']}{param_warning}

Context: {context}
Text: {key}"""

    response = translate_with_ollama(prompt, model, verbose)
    if not response:
        return None

    # Clean response
    translation = response.strip().split('\n')[0].strip()
    if (translation.startswith('"') and translation.endswith('"')) or \
       (translation.startswith("'") and translation.endswith("'")):
        translation = translation[1:-1]

    is_valid, error = validate_translation(key, translation, params)
    if not is_valid:
        if verbose:
            print(f"    Validation failed: {error}")
        return None

    return translation


def main():
    args = parse_args()

    print("\n" + "=" * 60)
    print("I18n Auto-Translation Script (Ollama)")
    print("=" * 60)

    # Check Ollama is running
    if not check_ollama_running():
        print("\nError: Ollama is not running!")
        print("Please start Ollama first:")
        print("  1. Open a terminal and run: ollama serve")
        print("  2. Or start the Ollama app")
        sys.exit(1)

    print(f"Ollama is running, using model: {args.model}")

    # Load input file
    input_path = args.input
    output_path = args.output
    checkpoint_path = get_checkpoint_path(output_path)

    if args.resume and os.path.exists(checkpoint_path):
        data = load_json(checkpoint_path)
        if data:
            print(f"Resuming from checkpoint: {checkpoint_path}")
        else:
            data = load_json(input_path)
    else:
        data = load_json(input_path)

    if not data:
        print(f"Error: Could not load input file: {input_path}")
        print("\nPlease run the extraction script first:")
        print(f"  node scripts/i18n-extract-strings.cjs --lang={args.lang}")
        sys.exit(1)

    existing_translations = load_existing_translations(args.lang)
    locale_path = get_locale_path(args.lang)
    translations = data.get('translations', [])

    skipped_from_locale = 0
    if not args.force and existing_translations:
        for t in translations:
            if not t.get('translation') and t['key'] in existing_translations:
                t['translation'] = existing_translations[t['key']]
                t['_from_locale'] = True
                skipped_from_locale += 1

    pending = [t for t in translations if not t.get('translation')]
    completed = [t for t in translations if t.get('translation')]

    print(f"\nInput: {input_path}")
    print(f"Output: {output_path}")
    print(f"Target language: {args.lang}")
    print(f"Model: {args.model}")
    print(f"Total strings: {len(translations)}")
    print(f"Already translated: {len(completed)}")
    print(f"Pending: {len(pending)}")

    if not pending:
        print("\nAll strings are already translated!")
        save_json(output_path, data)
        return

    if args.dry_run:
        print("\n[DRY RUN] Would translate:")
        for i, item in enumerate(pending[:10]):
            print(f"  {i + 1}. \"{item['key'][:50]}...\"" if len(item['key']) > 50 else f"  {i + 1}. \"{item['key']}\"")
        if len(pending) > 10:
            print(f"  ... and {len(pending) - 10} more")
        return

    # Translation loop
    print("\n" + "-" * 40)
    print(f"Starting translation (batch size: {args.batch_size})...")
    print("-" * 40)

    failed = []
    start_time = time.time()
    total_processed = 0

    for batch_start in range(0, len(pending), args.batch_size):
        batch_end = min(batch_start + args.batch_size, len(pending))
        batch_items = pending[batch_start:batch_end]

        safe_print(f"\n[Batch {batch_start // args.batch_size + 1}] Translating {len(batch_items)} strings...")

        for i, item in enumerate(batch_items):
            key_display = item['key'][:40] + '...' if len(item['key']) > 40 else item['key']
            key_display = key_display.replace('\n', '\\n')
            safe_print(f"  {batch_start + i + 1}. \"{key_display}\"")

        batch_translations = translate_batch(batch_items, args.lang, args.model, args.verbose)

        for i, (item, translation) in enumerate(zip(batch_items, batch_translations)):
            if translation:
                item['translation'] = translation
                trans_display = translation[:40] + '...' if len(translation) > 40 else translation
                safe_print(f"  -> {batch_start + i + 1}. \"{trans_display}\"")
            else:
                # Retry single
                safe_print(f"  -> {batch_start + i + 1}. Retrying single...")
                single = translate_single(
                    item['key'], item.get('context', 'UI text'),
                    item.get('params', []), args.lang, args.model, args.verbose
                )
                if single:
                    item['translation'] = single
                    safe_print(f"     OK: \"{single[:40]}...\"" if len(single) > 40 else f"     OK: \"{single}\"")
                else:
                    failed.append(item['key'])
                    safe_print(f"     FAILED")

        total_processed += len(batch_items)

        if total_processed % args.checkpoint_interval < args.batch_size:
            print(f"\n  [Checkpoint saved]")
            save_json(checkpoint_path, data)

    elapsed = time.time() - start_time
    save_json(output_path, data)

    if os.path.exists(checkpoint_path) and not failed:
        os.remove(checkpoint_path)

    print("\n" + "=" * 60)
    print("Translation Summary")
    print("=" * 60)
    print(f"Total processed: {len(pending)}")
    print(f"Successful: {len(pending) - len(failed)}")
    print(f"Failed: {len(failed)}")
    print(f"Time: {elapsed:.1f}s ({elapsed / max(len(pending), 1):.2f}s/string)")
    print(f"\nOutput: {output_path}")

    if failed:
        print(f"\nFailed ({len(failed)}):")
        for key in failed[:5]:
            print(f"  - \"{key[:60]}...\"" if len(key) > 60 else f"  - \"{key}\"")
        if len(failed) > 5:
            print(f"  ... and {len(failed) - 5} more")

    print("\nNext: node scripts/i18n-merge-translations.cjs --locale=" + args.lang)


if __name__ == '__main__':
    main()

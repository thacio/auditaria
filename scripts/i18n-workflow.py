#!/usr/bin/env python3

"""
I18n Unified Workflow Script

Complete workflow for i18n translation:
1. Build with transformation (generates report)
2. Extract untranslated strings from report
3. Translate strings using Ollama (GPU-accelerated)
4. Cleanup unused keys from locale files
5. Merge translations back into locale file

Setup:
    1. Install Ollama from https://ollama.com
    2. Run: ollama pull gemma3:27b
    3. Run this script: python scripts/i18n-workflow.py --lang=pt

Usage:
    python scripts/i18n-workflow.py                   # Auto-detect all languages
    python scripts/i18n-workflow.py --lang=pt         # Specific language
    python scripts/i18n-workflow.py --lang=pt --skip-build
    python scripts/i18n-workflow.py --lang=pt --step=extract
    python scripts/i18n-workflow.py --lang=pt --step=translate
    python scripts/i18n-workflow.py --lang=pt --step=cleanup
    python scripts/i18n-workflow.py --lang=pt --step=merge
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Any

try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False


def safe_print(text: str) -> None:
    """Print text safely, handling Unicode encoding errors on Windows."""
    try:
        print(text)
    except UnicodeEncodeError:
        safe_text = text.encode('ascii', 'replace').decode('ascii')
        print(safe_text)


# =============================================================================
# Configuration
# =============================================================================

LANGUAGE_CONFIG = {
    # Romance languages
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
    'it': {
        'name': 'Italian',
        'code': 'it',
        'instructions': 'Use informal "tu" form. Be concise.',
    },
    'ro': {
        'name': 'Romanian',
        'code': 'ro',
        'instructions': 'Use informal "tu" form. Be concise.',
    },
    # Germanic languages
    'de': {
        'name': 'German',
        'code': 'de',
        'instructions': 'Use informal "du" form. Be concise.',
    },
    'nl': {
        'name': 'Dutch',
        'code': 'nl',
        'instructions': 'Use informal "je" form. Be concise.',
    },
    'sv': {
        'name': 'Swedish',
        'code': 'sv',
        'instructions': 'Use informal "du" form. Be concise.',
    },
    'no': {
        'name': 'Norwegian',
        'code': 'no',
        'instructions': 'Use informal "du" form. Be concise.',
    },
    'da': {
        'name': 'Danish',
        'code': 'da',
        'instructions': 'Use informal "du" form. Be concise.',
    },
    # Slavic languages
    'ru': {
        'name': 'Russian',
        'code': 'ru',
        'instructions': 'Use informal "ты" form. Be concise.',
    },
    'pl': {
        'name': 'Polish',
        'code': 'pl',
        'instructions': 'Use informal "ty" form. Be concise.',
    },
    'cs': {
        'name': 'Czech',
        'code': 'cs',
        'instructions': 'Use informal "ty" form. Be concise.',
    },
    'uk': {
        'name': 'Ukrainian',
        'code': 'uk',
        'instructions': 'Use informal "ти" form. Be concise.',
    },
    # Asian languages
    'ja': {
        'name': 'Japanese',
        'code': 'ja',
        'instructions': 'Use polite form (です/ます). Be concise.',
    },
    'ko': {
        'name': 'Korean',
        'code': 'ko',
        'instructions': 'Use polite form (해요체). Be concise.',
    },
    'zh': {
        'name': 'Chinese (Simplified)',
        'code': 'zh-CN',
        'instructions': 'Use Simplified Chinese. Be concise.',
    },
    'zh-tw': {
        'name': 'Chinese (Traditional)',
        'code': 'zh-TW',
        'instructions': 'Use Traditional Chinese. Be concise.',
    },
    'vi': {
        'name': 'Vietnamese',
        'code': 'vi',
        'instructions': 'Use informal form. Be concise.',
    },
    'th': {
        'name': 'Thai',
        'code': 'th',
        'instructions': 'Use polite form. Be concise.',
    },
    'id': {
        'name': 'Indonesian',
        'code': 'id',
        'instructions': 'Use informal form. Be concise.',
    },
    'ms': {
        'name': 'Malay',
        'code': 'ms',
        'instructions': 'Use informal form. Be concise.',
    },
    'hi': {
        'name': 'Hindi',
        'code': 'hi',
        'instructions': 'Use informal "तुम" form. Be concise.',
    },
    # Other languages
    'tr': {
        'name': 'Turkish',
        'code': 'tr',
        'instructions': 'Use informal "sen" form. Be concise.',
    },
    'ar': {
        'name': 'Arabic',
        'code': 'ar',
        'instructions': 'Use Modern Standard Arabic. Be concise.',
    },
    'he': {
        'name': 'Hebrew',
        'code': 'he',
        'instructions': 'Use informal form. Be concise.',
    },
    'el': {
        'name': 'Greek',
        'code': 'el',
        'instructions': 'Use informal "εσύ" form. Be concise.',
    },
    'hu': {
        'name': 'Hungarian',
        'code': 'hu',
        'instructions': 'Use informal "te" form. Be concise.',
    },
    'fi': {
        'name': 'Finnish',
        'code': 'fi',
        'instructions': 'Use informal "sinä" form. Be concise.',
    },
}


def get_language_config(lang_code: str) -> Dict[str, str]:
    """Get language configuration. Raises error for unknown languages."""
    if lang_code in LANGUAGE_CONFIG:
        return LANGUAGE_CONFIG[lang_code]

    # List available languages in error message
    available = ', '.join(sorted(LANGUAGE_CONFIG.keys()))
    raise ValueError(
        f"Unknown language code: '{lang_code}'\n"
        f"Available languages: {available}\n"
        f"To add a new language, update LANGUAGE_CONFIG in this script."
    )


def is_language_supported(lang_code: str) -> bool:
    """Check if a language code is supported."""
    return lang_code in LANGUAGE_CONFIG

# Ollama configuration
OLLAMA_API_URL = 'http://localhost:11434/api/generate'
DEFAULT_MODEL = 'gemma3:27b'

AVAILABLE_MODELS = {
    'gemma3:27b': {'size': '17 GB', 'description': 'Best quality, requires ~16GB VRAM'},
    'gemma3:12b': {'size': '8 GB', 'description': 'Good balance of quality and speed'},
    'gemma3:4b': {'size': '3 GB', 'description': 'Fastest, lower quality'},
}


# =============================================================================
# Utility Functions
# =============================================================================

def get_project_root() -> Path:
    """Get the project root directory."""
    return Path(__file__).parent.parent


def get_locales_dir() -> Path:
    """Get the locales directory path."""
    return get_project_root() / "packages" / "core" / "src" / "i18n" / "locales"


def get_locale_path(lang_code: str) -> Path:
    """Get the path to the locale file for a language."""
    return get_locales_dir() / f"{lang_code}.json"


def detect_available_locales() -> List[str]:
    """Detect all available locale files in the locales directory."""
    locales_dir = get_locales_dir()
    if not locales_dir.exists():
        return []

    locales = []
    for file in locales_dir.glob("*.json"):
        # Extract language code from filename (e.g., "pt.json" -> "pt")
        lang_code = file.stem
        # Skip backup files
        if '.backup' in lang_code:
            continue
        locales.append(lang_code)

    return sorted(locales)


def get_report_path() -> Path:
    """Get the path to the i18n transformation report."""
    return get_project_root() / "i18n-transform-report.json"


def load_json(path: Path) -> Optional[Dict]:
    """Load JSON file."""
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except json.JSONDecodeError as e:
        print(f"Error parsing {path}: {e}")
        return None


def save_json(path: Path, data: Dict) -> None:
    """Save JSON file."""
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def check_ollama_running() -> bool:
    """Check if Ollama is running."""
    if not HAS_REQUESTS:
        return False
    try:
        response = requests.get('http://localhost:11434/api/tags', timeout=5)
        return response.status_code == 200
    except requests.exceptions.ConnectionError:
        return False


def check_model_available(model: str) -> bool:
    """Check if the specified model is available in Ollama."""
    if not HAS_REQUESTS:
        return False
    try:
        response = requests.get('http://localhost:11434/api/tags', timeout=5)
        if response.status_code == 200:
            data = response.json()
            models = [m['name'] for m in data.get('models', [])]
            return model in models or any(m.startswith(model.split(':')[0]) for m in models)
        return False
    except:
        return False


# =============================================================================
# Step 1: Build with Transformation
# =============================================================================

def run_build() -> bool:
    """Run npm bundle with i18n transformation enabled."""
    print("\n" + "=" * 60)
    print("Step 1: Building with I18N Transformation")
    print("=" * 60)

    project_root = get_project_root()

    # Set environment variables
    env = os.environ.copy()
    env['I18N_TRANSFORM'] = 'true'
    env['I18N_REPORT'] = 'true'

    print(f"Running: npm run bundle (with I18N_TRANSFORM=true I18N_REPORT=true)")
    print(f"Working directory: {project_root}")
    print()

    try:
        # Use shell=True on Windows for npm
        if sys.platform == 'win32':
            result = subprocess.run(
                'npm run bundle',
                cwd=project_root,
                env=env,
                shell=True,
                capture_output=False,
            )
        else:
            result = subprocess.run(
                ['npm', 'run', 'bundle'],
                cwd=project_root,
                env=env,
                capture_output=False,
            )

        if result.returncode != 0:
            print(f"\nBuild failed with return code {result.returncode}")
            return False

        # Check if report was generated
        report_path = get_report_path()
        if not report_path.exists():
            print(f"\nWarning: Report file not generated at {report_path}")
            return False

        print(f"\nBuild successful! Report generated at: {report_path}")
        return True

    except Exception as e:
        print(f"\nBuild error: {e}")
        return False


# =============================================================================
# Step 2: Extract Strings
# =============================================================================

def generate_context(transformation: Dict, file: str) -> str:
    """Generate context description based on transformation type."""
    t_type = transformation.get('type', '')

    context_map = {
        'property:description': 'CLI option or command description',
        'property:message': 'User notification or status message',
        'property:text': 'UI text or label',
        'property:label': 'Button or menu label',
        'property:title': 'Dialog or section title',
        'property:helpText': 'Help or hint text',
        'property:hint': 'Help or hint text',
        'JSXText': 'React component text content',
        'ParameterizedText': f"Parameterized text with variables: {', '.join(transformation.get('params', []))}",
        'I18nText': 'Nested text component',
    }

    if t_type in context_map:
        return context_map[t_type]

    # Default context based on file path
    if 'components' in file:
        return 'UI component text'
    elif 'commands' in file:
        return 'Command output'
    elif 'config' in file:
        return 'Configuration text'

    return 'User-facing text'


def extract_strings(lang: str, output_path: Path) -> Optional[Dict]:
    """Extract untranslated strings from the transformation report."""
    print("\n" + "=" * 60)
    print("Step 2: Extracting Untranslated Strings")
    print("=" * 60)

    report_path = get_report_path()
    locale_path = get_locale_path(lang)

    print(f"Report: {report_path}")
    print(f"Locale: {locale_path}")
    print(f"Output: {output_path}")
    print()

    # Load the transformation report
    if not report_path.exists():
        print(f"Error: Report file not found: {report_path}")
        print("\nPlease run the build step first or use --skip-build if report exists.")
        return None

    report = load_json(report_path)
    if not report:
        return None

    # Load existing translations
    existing_locale = load_json(locale_path)
    exact_strings = existing_locale.get('_exactStrings', {}) if existing_locale else {}

    print(f"Loaded {len(exact_strings)} existing translations")

    # Extract unique strings with their metadata
    strings_map = {}

    for file_detail in report.get('fileDetails', []):
        file = file_detail.get('file', '')

        for transformation in file_detail.get('transformations', []):
            key = transformation.get('original', '')

            # Skip empty or very short strings
            if not key or len(key.strip()) < 2:
                continue

            # Skip strings that are already translated
            if key in exact_strings:
                continue

            # Skip duplicates but collect all files where it appears
            if key in strings_map:
                if file not in strings_map[key]['files']:
                    strings_map[key]['files'].append(file)
                continue

            # Add new string
            strings_map[key] = {
                'key': key,
                'context': generate_context(transformation, file),
                'files': [file],
                'type': transformation.get('type', ''),
                'params': transformation.get('params', []),
                'translation': '',
            }

    # Convert to sorted list
    pending_translations = sorted(strings_map.values(), key=lambda x: x['key'])

    # Create output object
    output = {
        'metadata': {
            'sourceLanguage': 'en',
            'targetLanguage': lang,
            'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%S.000Z'),
            'totalStringsInReport': report.get('stringsTransformed', 0),
            'uniqueStrings': len(strings_map) + len(exact_strings),
            'alreadyTranslated': len(exact_strings),
            'pendingTranslation': len(pending_translations),
        },
        'translations': [
            {
                'key': item['key'],
                'context': item['context'],
                'file': item['files'][0],
                'files': item['files'] if len(item['files']) > 1 else None,
                'type': item['type'],
                'params': item['params'] if item['params'] else None,
                'translation': '',
            }
            for item in pending_translations
        ],
    }

    # Clean up None values
    for t in output['translations']:
        if t['files'] is None:
            del t['files']
        if t['params'] is None:
            del t['params']

    # Save output
    save_json(output_path, output)

    # Print summary
    print(f"\nExtraction Summary")
    print(f"------------------")
    print(f"Total strings in report: {output['metadata']['totalStringsInReport']}")
    print(f"Unique strings: {output['metadata']['uniqueStrings']}")
    print(f"Already translated: {output['metadata']['alreadyTranslated']}")
    print(f"Pending translation: {output['metadata']['pendingTranslation']}")
    print(f"\nOutput written to: {output_path}")

    # Show sample
    if pending_translations:
        print(f"\nSample pending strings (first 5):")
        for item in pending_translations[:5]:
            key_display = item['key'][:60] + '...' if len(item['key']) > 60 else item['key']
            print(f"  - \"{key_display}\"")
        if len(pending_translations) > 5:
            print(f"  ... and {len(pending_translations) - 5} more")

    return output


# =============================================================================
# Step 3: Translate Strings (using Ollama)
# =============================================================================

def build_batch_prompt(items: List[Dict], lang_code: str) -> str:
    """Build a batch translation prompt for multiple strings."""
    lang = get_language_config(lang_code)

    strings_list = []
    for i, item in enumerate(items, 1):
        key = item['key']
        strings_list.append(f"{i}. {key}")

    strings_text = "\n".join(strings_list)

    prompt = f"""Translate these UI texts from English to {lang['name']}.

RULES:
- Output ONLY numbered translations, one per line
- Format exactly: "1. translation" (number, dot, space, translation only)
- Keep {{placeholders}} exactly as they appear - do NOT translate them
- Keep slash commands (e.g., /help, /settings, /docs) exactly as they appear - do NOT translate them
- Keep technical terms (API, CLI, JSON, URL, MCP, OAuth, YOLO) unchanged
- Keep leading symbols like \\n, ---, numbers (1., 2., 3.) exactly as they appear
- {lang['instructions']}
- NO explanations, NO notes, ONLY translations

Texts:
{strings_text}"""
    return prompt


def parse_batch_response(response: str, count: int) -> List[Optional[str]]:
    """Parse batch translation response into individual translations."""
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
            translation = translation.strip()

            # Remove any leading "N. " prefix duplicates
            translation = re.sub(r'^(\d+)\.\s*', '', translation)

            if 0 <= idx < count and translation:
                results[idx] = translation

    return results


def validate_translation(original: str, translation: str, params: List[str]) -> tuple:
    """Validate that the translation is valid."""
    if not translation or not translation.strip():
        return False, "Empty translation"

    translation = translation.strip()

    # Remove quotes
    if translation.startswith('"') and translation.endswith('"'):
        translation = translation[1:-1]
    if translation.startswith("'") and translation.endswith("'"):
        translation = translation[1:-1]

    # Check parameters preserved
    for param in params:
        placeholder = f"{{{param}}}"
        if placeholder in original and placeholder not in translation:
            return False, f"Missing parameter: {placeholder}"

    # Check no new placeholders
    original_placeholders = set(re.findall(r'\{[^}]+\}', original))
    translation_placeholders = set(re.findall(r'\{[^}]+\}', translation))

    new_placeholders = translation_placeholders - original_placeholders
    if new_placeholders:
        return False, f"New placeholders introduced: {new_placeholders}"

    # Length sanity check
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
    """Translate a batch of strings using Ollama."""
    if not items:
        return []

    prompt = build_batch_prompt(items, lang_code)

    if verbose:
        print(f"\n--- Batch Prompt ---\n{prompt}\n--------------")

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
    """Translate a single string (fallback for failed batch items)."""
    lang = get_language_config(lang_code)

    param_warning = ""
    if params:
        param_list = ", ".join([f"{{{p}}}" for p in params])
        param_warning = f"\nIMPORTANT: Keep these placeholders exactly as-is: {param_list}"

    prompt = f"""Translate this UI text from English to {lang['name']}.

Rules:
- Output ONLY the translation, nothing else
- Keep placeholders like {{name}}, {{count}} UNCHANGED
- Keep slash commands (e.g., /help, /settings, /docs) exactly as they appear
- Keep technical terms (API, CLI, JSON, URL, MCP, OAuth, YOLO) unchanged
- {lang['instructions']}{param_warning}

Context: {context}
Text: {key}"""

    response = translate_with_ollama(prompt, model, verbose)
    if not response:
        return None

    # Clean response
    translation = response.strip().split('\n')[0].strip()

    # Remove quotes
    if (translation.startswith('"') and translation.endswith('"')) or \
       (translation.startswith("'") and translation.endswith("'")):
        translation = translation[1:-1]

    # Validate
    is_valid, error = validate_translation(key, translation, params)
    if not is_valid:
        if verbose:
            print(f"    Validation failed: {error}")
        return None

    return translation


def translate_strings(
    lang: str,
    input_path: Path,
    output_path: Path,
    model: str,
    batch_size: int,
    verbose: bool,
    force: bool,
) -> bool:
    """Translate all pending strings using Ollama."""
    print("\n" + "=" * 60)
    print("Step 3: Translating Strings (Ollama)")
    print("=" * 60)

    # Check Ollama
    if not HAS_REQUESTS:
        print("\nError: 'requests' module not installed. Run: pip install requests")
        return False

    if not check_ollama_running():
        print("\nError: Ollama is not running!")
        print("Please start Ollama first:")
        print("  1. Open a terminal and run: ollama serve")
        print("  2. Or start the Ollama app")
        return False

    print(f"Ollama is running, using model: {model}")

    # Check if model is available
    if not check_model_available(model):
        print(f"\nWarning: Model '{model}' may not be available.")
        print(f"Run: ollama pull {model}")

    # Load input
    data = load_json(input_path)
    if not data:
        print(f"Error: Could not load input file: {input_path}")
        return False

    # Load existing translations from locale
    existing_translations = {}
    locale_path = get_locale_path(lang)
    if locale_path.exists():
        locale_data = load_json(locale_path)
        if locale_data:
            existing_translations = locale_data.get('_exactStrings', {})

    translations = data.get('translations', [])

    # Mark already translated strings
    skipped_from_locale = 0
    if not force and existing_translations:
        for t in translations:
            if not t.get('translation') and t['key'] in existing_translations:
                t['translation'] = existing_translations[t['key']]
                t['_from_locale'] = True
                skipped_from_locale += 1

    pending = [t for t in translations if not t.get('translation')]
    completed = [t for t in translations if t.get('translation')]

    print(f"\nInput: {input_path}")
    print(f"Output: {output_path}")
    print(f"Target language: {lang}")
    print(f"Model: {model}")
    print(f"Force mode: {force}")
    print(f"Total strings: {len(translations)}")
    print(f"Already in locale file: {len(existing_translations)}")
    if not force:
        print(f"Skipped (already translated): {skipped_from_locale}")
    print(f"Pending translation: {len(pending)}")

    if not pending:
        print("\nAll strings are already translated!")
        save_json(output_path, data)
        return True

    # Translation loop
    print("\n" + "-" * 40)
    print(f"Starting translation (batch size: {batch_size})...")
    print("-" * 40)

    failed = []
    start_time = time.time()
    checkpoint_interval = 10
    checkpoint_path = output_path.with_suffix('.checkpoint.json')

    for batch_start in range(0, len(pending), batch_size):
        batch_end = min(batch_start + batch_size, len(pending))
        batch_items = pending[batch_start:batch_end]

        safe_print(f"\n[Batch {batch_start // batch_size + 1}] Translating {len(batch_items)} strings ({batch_start + 1}-{batch_end} of {len(pending)})...")

        # Show batch items
        for i, item in enumerate(batch_items):
            key_display = item['key'][:40] + '...' if len(item['key']) > 40 else item['key']
            key_display = key_display.replace('\n', '\\n')
            safe_print(f"  {batch_start + i + 1}. \"{key_display}\"")

        # Translate batch
        batch_translations = translate_batch(batch_items, lang, model, verbose)

        # Process results
        for i, (item, translation) in enumerate(zip(batch_items, batch_translations)):
            if translation:
                item['translation'] = translation
                trans_display = translation[:40] + '...' if len(translation) > 40 else translation
                safe_print(f"  -> {batch_start + i + 1}. \"{trans_display}\"")
            else:
                # Retry single
                safe_print(f"  -> {batch_start + i + 1}. Batch failed, retrying single...")
                single_translation = translate_single(
                    item['key'], item.get('context', 'UI text'),
                    item.get('params', []), lang, model, verbose
                )
                if single_translation:
                    item['translation'] = single_translation
                    trans_display = single_translation[:40] + '...' if len(single_translation) > 40 else single_translation
                    safe_print(f"     Retry OK: \"{trans_display}\"")
                else:
                    failed.append(item['key'])
                    safe_print(f"     Retry FAILED")

        # Checkpoint
        if (batch_start + batch_size) % checkpoint_interval < batch_size:
            print(f"\n  [Checkpoint saved]")
            save_json(checkpoint_path, data)

    # Final save
    elapsed = time.time() - start_time
    save_json(output_path, data)

    # Clean up checkpoint
    if checkpoint_path.exists() and not failed:
        checkpoint_path.unlink()

    # Summary
    print("\n" + "=" * 60)
    print("Translation Summary")
    print("=" * 60)
    print(f"Total processed: {len(pending)}")
    print(f"Successful: {len(pending) - len(failed)}")
    print(f"Failed: {len(failed)}")
    print(f"Time elapsed: {elapsed:.1f}s")
    if len(pending) > 0:
        print(f"Average: {elapsed / len(pending):.2f}s per string")
    print(f"\nOutput saved to: {output_path}")

    if failed:
        print(f"\nFailed translations ({len(failed)}):")
        for key in failed[:10]:
            key_display = key[:60] + '...' if len(key) > 60 else key
            print(f"  - \"{key_display}\"")
        if len(failed) > 10:
            print(f"  ... and {len(failed) - 10} more")

    return len(failed) == 0


# =============================================================================
# Step 4: Cleanup Unused Keys
# =============================================================================

def cleanup_unused_keys(lang: str, backup: bool = True, dry_run: bool = False) -> bool:
    """Remove unused keys from the locale file that are no longer in the codebase."""
    print("\n" + "=" * 60)
    print("Step 4: Cleanup Unused Keys")
    print("=" * 60)

    report_path = get_report_path()
    locale_path = get_locale_path(lang)

    print(f"Report: {report_path}")
    print(f"Locale: {locale_path}")
    print(f"Dry run: {dry_run}")
    print()

    # Load the transformation report
    if not report_path.exists():
        print(f"Error: Report file not found: {report_path}")
        print("\nPlease run the build step first.")
        return False

    report = load_json(report_path)
    if not report:
        return False

    # Load existing locale
    if not locale_path.exists():
        print(f"Locale file not found: {locale_path}")
        print("Nothing to cleanup.")
        return True

    existing_locale = load_json(locale_path)
    if not existing_locale:
        return False

    existing_exact_strings = existing_locale.get('_exactStrings', {})
    if not existing_exact_strings:
        print("No translations in locale file. Nothing to cleanup.")
        return True

    # Extract all unique strings from the report (these are the keys currently in use)
    used_keys = set()
    for file_detail in report.get('fileDetails', []):
        for transformation in file_detail.get('transformations', []):
            key = transformation.get('original', '')
            if key and len(key.strip()) >= 2:
                used_keys.add(key)

    print(f"Unique strings in codebase: {len(used_keys)}")
    print(f"Translations in locale file: {len(existing_exact_strings)}")

    # Find unused keys (in locale but not in codebase)
    locale_keys = set(existing_exact_strings.keys())
    unused_keys = locale_keys - used_keys

    if not unused_keys:
        print("\nNo unused keys found. Locale file is clean!")
        return True

    print(f"\nFound {len(unused_keys)} unused keys to remove:")

    # Show sample of unused keys
    unused_list = sorted(unused_keys)
    for key in unused_list[:10]:
        key_display = key[:60] + '...' if len(key) > 60 else key
        key_display = key_display.replace('\n', '\\n')
        safe_print(f"  - \"{key_display}\"")
    if len(unused_list) > 10:
        print(f"  ... and {len(unused_list) - 10} more")

    if dry_run:
        print(f"\n[DRY RUN] Would remove {len(unused_keys)} unused keys from {locale_path}")
        return True

    # Create new locale without unused keys
    cleaned_exact_strings = {k: v for k, v in existing_exact_strings.items() if k in used_keys}

    # Sort alphabetically
    sorted_exact_strings = dict(sorted(cleaned_exact_strings.items()))

    # Create new locale structure
    new_locale = {
        '_exactStrings': sorted_exact_strings,
    }

    # Backup
    if backup and locale_path.exists():
        import shutil
        timestamp = time.strftime('%Y%m%d-%H%M%S')
        backup_path = locale_path.with_suffix(f'.backup-{timestamp}.json')
        shutil.copy(locale_path, backup_path)
        print(f"\nBackup created: {backup_path}")

    # Write
    save_json(locale_path, new_locale)

    # Summary
    print(f"\nCleanup Summary")
    print(f"---------------")
    print(f"Removed: {len(unused_keys)} unused keys")
    print(f"Kept: {len(sorted_exact_strings)} translations")
    print(f"\nLocale file updated: {locale_path}")

    return True


# =============================================================================
# Step 5: Merge Translations
# =============================================================================

def merge_translations(lang: str, input_path: Path, backup: bool = True) -> bool:
    """Merge completed translations into the locale file."""
    print("\n" + "=" * 60)
    print("Step 5: Merging Translations into Locale File")
    print("=" * 60)

    locale_path = get_locale_path(lang)

    print(f"Input: {input_path}")
    print(f"Locale: {locale_path}")
    print()

    # Load completed translations
    if not input_path.exists():
        print(f"Error: Input file not found: {input_path}")
        return False

    completed_data = load_json(input_path)
    if not completed_data:
        return False

    translations = completed_data.get('translations', [])

    # Filter valid translations
    valid_translations = [t for t in translations if t.get('translation') and t['translation'].strip()]

    if not valid_translations:
        print('No translations to merge.')
        return True

    print(f"Found {len(valid_translations)} translations to merge")

    # Load existing locale
    existing_locale = load_json(locale_path)
    existing_exact_strings = existing_locale.get('_exactStrings', {}) if existing_locale else {}

    # Merge
    new_count = 0
    updated_count = 0
    unchanged_count = 0

    new_exact_strings = dict(existing_exact_strings)

    for item in valid_translations:
        key = item['key']
        translation = item['translation'].strip()

        if key not in new_exact_strings:
            new_exact_strings[key] = translation
            new_count += 1
        elif new_exact_strings[key] != translation:
            print(f"  Updating: \"{key[:40]}...\"")
            new_exact_strings[key] = translation
            updated_count += 1
        else:
            unchanged_count += 1

    # Sort alphabetically
    sorted_exact_strings = dict(sorted(new_exact_strings.items()))

    # Create new locale structure
    new_locale = {
        '_exactStrings': sorted_exact_strings,
    }

    # Print summary
    print(f"\nMerge Summary")
    print(f"-------------")
    print(f"New translations: {new_count}")
    print(f"Updated translations: {updated_count}")
    print(f"Unchanged: {unchanged_count}")
    print(f"Total in _exactStrings: {len(sorted_exact_strings)}")

    # Backup
    if backup and locale_path.exists():
        timestamp = time.strftime('%Y%m%d-%H%M%S')
        backup_path = locale_path.with_suffix(f'.backup-{timestamp}.json')
        import shutil
        shutil.copy(locale_path, backup_path)
        print(f"\nBackup created: {backup_path}")

    # Write
    save_json(locale_path, new_locale)
    print(f"\nLocale file updated: {locale_path}")

    # Show sample
    print(f"\nSample translations:")
    sample_keys = list(sorted_exact_strings.keys())[:5]
    for key in sample_keys:
        print(f"  \"{key[:30]}...\" => \"{sorted_exact_strings[key][:30]}...\"")
    if len(sorted_exact_strings) > 5:
        print(f"  ... and {len(sorted_exact_strings) - 5} more")

    return True


# =============================================================================
# Main
# =============================================================================

def parse_args():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description='Complete i18n translation workflow using Ollama',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python scripts/i18n-workflow.py                        # Auto-detect all languages
  python scripts/i18n-workflow.py --lang=pt              # Single language
  python scripts/i18n-workflow.py --skip-build           # Skip build (all languages)
  python scripts/i18n-workflow.py --skip-cleanup         # Skip cleanup (keep unused keys)
  python scripts/i18n-workflow.py --lang=pt --step=translate  # Only translate
  python scripts/i18n-workflow.py --lang=pt --step=cleanup    # Only remove unused keys
  python scripts/i18n-workflow.py --lang=pt --step=merge      # Only merge
  python scripts/i18n-workflow.py --list-languages       # List supported languages
  python scripts/i18n-workflow.py --list-models          # List available models

Setup:
  1. Install Ollama: https://ollama.com
  2. Pull model: ollama pull gemma3:27b
        """
    )

    parser.add_argument('--lang', '-l', default=None, help='Target language code (auto-detects all if not specified)')
    parser.add_argument('--step', '-s', choices=['build', 'extract', 'translate', 'cleanup', 'merge'], help='Run only a specific step')
    parser.add_argument('--skip-build', action='store_true', help='Skip the build step (use existing report)')
    parser.add_argument('--skip-cleanup', action='store_true', help='Skip the cleanup step (keep unused keys in locale files)')
    parser.add_argument('--force', action='store_true', help='Force re-translation of all strings')
    parser.add_argument('--model', '-m', default=DEFAULT_MODEL, help=f'Ollama model name (default: {DEFAULT_MODEL})')
    parser.add_argument('--batch-size', '-b', type=int, default=30, help='Batch size for translation (default: 30)')
    parser.add_argument('--backup', action='store_true', help="Create backup of locale file before merge (disabled by default, use git instead)")
    parser.add_argument('--verbose', '-v', action='store_true', help='Verbose output')
    parser.add_argument('--list-languages', action='store_true', help='List supported languages')
    parser.add_argument('--list-models', action='store_true', help='List available models')
    parser.add_argument('--dry-run', action='store_true', help='Show what would be done without executing')

    return parser.parse_args()


def process_language(
    lang: str,
    args,
    should_extract: bool,
    should_translate: bool,
    should_cleanup: bool,
    should_merge: bool,
) -> bool:
    """Process a single language through extract, translate, cleanup, and merge steps.

    Returns True if successful, False otherwise.
    """
    project_root = get_project_root()
    # Use language-specific file names to allow parallel processing
    pending_path = project_root / f'i18n-pending-translations-{lang}.json'
    completed_path = project_root / f'i18n-completed-translations-{lang}.json'

    print("\n" + "-" * 60)
    print(f"Processing language: {lang}")
    print("-" * 60)

    # Step 2: Extract
    if should_extract:
        if args.dry_run:
            print(f"\n[Would extract] strings to {pending_path}")
        else:
            result = extract_strings(lang, pending_path)
            if result is None:
                print(f"\nExtraction failed for {lang}.")
                return False

    # Step 3: Translate
    if should_translate:
        if args.dry_run:
            print(f"\n[Would translate] strings from {pending_path} to {completed_path}")
        else:
            success = translate_strings(
                lang=lang,
                input_path=pending_path,
                output_path=completed_path,
                model=args.model,
                batch_size=args.batch_size,
                verbose=args.verbose,
                force=args.force,
            )
            if not success:
                print(f"\nTranslation had some failures for {lang}. Check output file.")

    # Step 4: Cleanup unused keys
    if should_cleanup:
        if args.dry_run:
            print(f"\n[Would cleanup] unused keys from locale file for {lang}")
            cleanup_unused_keys(lang, backup=args.backup, dry_run=True)
        else:
            success = cleanup_unused_keys(lang, backup=args.backup, dry_run=False)
            if not success:
                print(f"\nCleanup failed for {lang}.")
                return False

    # Step 5: Merge
    if should_merge:
        if args.dry_run:
            print(f"\n[Would merge] translations from {completed_path} into locale file")
        else:
            success = merge_translations(lang, completed_path, backup=args.backup)
            if not success:
                print(f"\nMerge failed for {lang}.")
                return False

    return True


def main():
    args = parse_args()

    # List languages
    if args.list_languages:
        print("\nSupported languages:")
        print("-" * 60)
        for code in sorted(LANGUAGE_CONFIG.keys()):
            config = LANGUAGE_CONFIG[code]
            print(f"  {code:8} - {config['name']}")
        print(f"\nTotal: {len(LANGUAGE_CONFIG)} languages")
        print("\nTo add a new language, create a locale file (e.g., ja.json)")
        print("and add the language config to LANGUAGE_CONFIG in this script.")
        return

    # List models
    if args.list_models:
        print("\nAvailable Ollama models for translation:")
        print("-" * 60)
        for model, config in AVAILABLE_MODELS.items():
            print(f"\n  {model}")
            print(f"    Size: {config['size']}")
            print(f"    Description: {config['description']}")
        print("\nTo download a model, run:")
        print("  ollama pull <model-name>")
        return

    project_root = get_project_root()

    # Determine languages to process
    if args.lang:
        # Validate the specified language
        if not is_language_supported(args.lang):
            available = ', '.join(sorted(LANGUAGE_CONFIG.keys()))
            print(f"\nError: Unknown language code: '{args.lang}'")
            print(f"Available languages: {available}")
            print("\nUse --list-languages to see all supported languages.")
            print("To add a new language, update LANGUAGE_CONFIG in this script.")
            sys.exit(1)
        languages = [args.lang]
    else:
        # Auto-detect from locale files
        detected = detect_available_locales()
        if not detected:
            print("\nNo locale files found in the locales directory.")
            print("Please create at least one locale file (e.g., pt.json) first.")
            sys.exit(1)

        # Validate all detected languages
        unsupported = [lang for lang in detected if not is_language_supported(lang)]
        if unsupported:
            print(f"\nError: Found locale files for unsupported languages: {', '.join(unsupported)}")
            print("\nEither:")
            print("  1. Add these languages to LANGUAGE_CONFIG in this script, or")
            print("  2. Use --lang=<code> to process a specific supported language")
            print("\nUse --list-languages to see all supported languages.")
            sys.exit(1)

        languages = detected

    print("\n" + "=" * 60)
    print("I18n Unified Workflow (Ollama)")
    print("=" * 60)
    print(f"Languages: {', '.join(languages)}")
    print(f"Model: {args.model}")
    print(f"Project root: {project_root}")

    if args.dry_run:
        print("\n[DRY RUN MODE]")

    # Determine which steps to run
    should_build = not args.skip_build and args.step in (None, 'build')
    should_extract = args.step in (None, 'extract')
    should_translate = args.step in (None, 'translate')
    should_cleanup = not args.skip_cleanup and args.step in (None, 'cleanup')
    should_merge = args.step in (None, 'merge')

    if args.step:
        print(f"Running only step: {args.step}")

    # Step 1: Build (only once, before processing any language)
    if should_build:
        if args.dry_run:
            print("\n[Would run] npm run bundle with I18N_TRANSFORM=true I18N_REPORT=true")
        else:
            if not run_build():
                print("\nBuild failed. Aborting workflow.")
                sys.exit(1)

    # Process each language
    results = {}
    for lang in languages:
        success = process_language(
            lang=lang,
            args=args,
            should_extract=should_extract,
            should_translate=should_translate,
            should_cleanup=should_cleanup,
            should_merge=should_merge,
        )
        results[lang] = success

    # Summary
    print("\n" + "=" * 60)
    print("Workflow Complete!")
    print("=" * 60)

    if len(languages) > 1:
        print("\nResults by language:")
        for lang, success in results.items():
            status = "OK" if success else "FAILED"
            print(f"  {lang}: {status}")

    print("\nNext steps:")
    print("  1. Review the locale files for any issues")
    print("  2. Rebuild the application:")
    print("     I18N_TRANSFORM=true npm run bundle")
    print(f"  3. Test with a target language:")
    print(f"     AUDITARIA_LANG={languages[0]} node bundle/gemini.js")


if __name__ == '__main__':
    main()

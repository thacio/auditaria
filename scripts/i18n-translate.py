#!/usr/bin/env python3

"""
I18n Auto-Translation Script

Uses Gemma 3 model via llama.cpp to translate UI strings
from English to the target language.

Hardware requirement: NVIDIA GPU with at least 16GB VRAM for 27B Q4
Recommended: RTX 4090 or similar

Setup:
    pip install llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu121

Usage:
    python scripts/i18n-translate.py --lang=pt
    python scripts/i18n-translate.py --lang=pt --force  # Re-translate everything
    python scripts/i18n-translate.py --resume
    python scripts/i18n-translate.py --model=unsloth/gemma-3-27b-it-GGUF
"""

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Any


def safe_print(text: str) -> None:
    """Print text safely, handling Unicode encoding errors on Windows."""
    try:
        print(text)
    except UnicodeEncodeError:
        # Replace problematic characters with ASCII equivalents
        safe_text = text.encode('ascii', 'replace').decode('ascii')
        print(safe_text)

# Try to import llama-cpp-python
try:
    from llama_cpp import Llama
    HAS_LLAMA = True
except ImportError:
    HAS_LLAMA = False
    print("Warning: llama-cpp-python not installed.")
    print("Install with CUDA support:")
    print("  pip install llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu121")
    print("\nOr for CPU only:")
    print("  pip install llama-cpp-python")


# Language configurations
LANGUAGE_CONFIG = {
    'pt': {
        'name': 'Portuguese (Brazilian)',
        'code': 'pt-BR',
        'form': 'informal "você"',
        'instructions': 'Use informal "você" form, not "tu". Be concise.',
    },
    'es': {
        'name': 'Spanish',
        'code': 'es',
        'form': 'informal "tú"',
        'instructions': 'Use informal "tú" form. Be concise.',
    },
    'fr': {
        'name': 'French',
        'code': 'fr',
        'form': 'informal "tu"',
        'instructions': 'Use informal "tu" form. Be concise.',
    },
    'de': {
        'name': 'German',
        'code': 'de',
        'form': 'informal "du"',
        'instructions': 'Use informal "du" form. Be concise.',
    },
}

# Model configurations (GGUF repos on HuggingFace)
MODEL_CONFIGS = {
    'unsloth/gemma-3-27b-it-GGUF': {
        'filename': 'gemma-3-27b-it-Q4_K_M.gguf',
        'size_gb': 16.5,
        'description': 'Unsloth Dynamic 2.0 quant - best quality',
    },
    'bartowski/google_gemma-3-27b-it-GGUF': {
        'filename': 'gemma-3-27b-it-Q4_K_M.gguf',
        'size_gb': 16.5,
        'description': 'Bartowski imatrix quant',
    },
    'ggml-org/gemma-3-27b-it-GGUF': {
        'filename': 'gemma-3-27b-it-Q4_K_M.gguf',
        'size_gb': 16.5,
        'description': 'Official ggml-org quant',
    },
    # Smaller models for less VRAM
    'unsloth/gemma-3-12b-it-GGUF': {
        'filename': 'gemma-3-12b-it-Q4_K_M.gguf',
        'size_gb': 8,
        'description': 'Smaller 12B model',
    },
    'unsloth/gemma-3-4b-it-GGUF': {
        'filename': 'gemma-3-4b-it-Q8_0.gguf',
        'size_gb': 4.5,
        'description': 'Smallest 4B model',
    },
}

DEFAULT_MODEL = 'unsloth/gemma-3-27b-it-GGUF'


def parse_args():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description='Auto-translate i18n strings using Gemma 3 via llama.cpp',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python scripts/i18n-translate.py --lang=pt
  python scripts/i18n-translate.py --lang=pt --force  # Re-translate all strings
  python scripts/i18n-translate.py --resume
  python scripts/i18n-translate.py --model=unsloth/gemma-3-12b-it-GGUF
  python scripts/i18n-translate.py --list-models

Available models:
  unsloth/gemma-3-27b-it-GGUF    - 16.5GB, best quality (default)
  unsloth/gemma-3-12b-it-GGUF    - 8GB, good balance
  unsloth/gemma-3-4b-it-GGUF     - 4.5GB, fastest
        """
    )
    parser.add_argument(
        '--lang', '-l',
        default='pt',
        help='Target language code (default: pt)'
    )
    parser.add_argument(
        '--input', '-i',
        default='i18n-pending-translations.json',
        help='Input file with pending translations'
    )
    parser.add_argument(
        '--output', '-o',
        default='i18n-completed-translations.json',
        help='Output file for completed translations'
    )
    parser.add_argument(
        '--model', '-m',
        default=DEFAULT_MODEL,
        help=f'Model repo ID (default: {DEFAULT_MODEL})'
    )
    parser.add_argument(
        '--filename', '-f',
        help='Specific GGUF filename (auto-detected if not provided)'
    )
    parser.add_argument(
        '--resume', '-r',
        action='store_true',
        help='Resume from checkpoint'
    )
    parser.add_argument(
        '--checkpoint-interval',
        type=int,
        default=10,
        help='Save checkpoint every N translations (default: 10)'
    )
    parser.add_argument(
        '--batch-size', '-b',
        type=int,
        default=5,
        help='Number of strings to translate per batch (default: 5)'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Show what would be translated without loading model'
    )
    parser.add_argument(
        '--list-models',
        action='store_true',
        help='List available models and exit'
    )
    parser.add_argument(
        '--n-gpu-layers', '-ngl',
        type=int,
        default=-1,
        help='Number of layers to offload to GPU (-1 = all, default: -1)'
    )
    parser.add_argument(
        '--n-ctx',
        type=int,
        default=4096,
        help='Context size (default: 4096)'
    )
    parser.add_argument(
        '--verbose', '-v',
        action='store_true',
        help='Verbose output'
    )
    parser.add_argument(
        '--force',
        action='store_true',
        help='Force re-translation of all strings, even if already translated in locale file'
    )
    return parser.parse_args()


def get_checkpoint_path(output_path: str) -> str:
    """Get checkpoint file path based on output path."""
    return output_path.replace('.json', '.checkpoint.json')


def get_locale_path(lang_code: str) -> Path:
    """Get the path to the locale file for a language."""
    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    return project_root / "packages" / "core" / "src" / "i18n" / "locales" / f"{lang_code}.json"


def load_existing_translations(lang_code: str) -> Dict[str, str]:
    """Load existing translations from the locale file."""
    locale_path = get_locale_path(lang_code)
    if not locale_path.exists():
        return {}

    try:
        with open(locale_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
            return data.get('_exactStrings', {})
    except (json.JSONDecodeError, IOError) as e:
        print(f"Warning: Could not load locale file {locale_path}: {e}")
        return {}


def load_json(path: str) -> Optional[Dict]:
    """Load JSON file."""
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except json.JSONDecodeError as e:
        print(f"Error parsing {path}: {e}")
        return None


def save_json(path: str, data: Dict) -> None:
    """Save JSON file."""
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def build_prompt(key: str, context: str, file: str, params: List[str], lang_code: str) -> str:
    """Build the translation prompt for Gemma 3 (single string)."""
    lang = LANGUAGE_CONFIG.get(lang_code, {
        'name': lang_code.upper(),
        'instructions': 'Be concise.',
    })

    # Build parameter warning if needed
    param_warning = ""
    if params:
        param_list = ", ".join([f"{{{p}}}" for p in params])
        param_warning = f"\nIMPORTANT: Keep these placeholders exactly as-is: {param_list}"

    # Gemma 3 chat format
    prompt = f"""<start_of_turn>user
Translate this UI text from English to {lang['name']}.

Rules:
- Output ONLY the translation, nothing else
- Keep placeholders like {{name}}, {{count}} UNCHANGED
- Keep slash commands (e.g., /help, /settings, /docs) exactly as they appear - do NOT translate them
- Keep technical terms (API, CLI, JSON, URL, MCP, OAuth, YOLO) unchanged
- {lang['instructions']}{param_warning}

Context: {context}
Text: {key}
<end_of_turn>
<start_of_turn>model
"""
    return prompt


def build_batch_prompt(items: List[Dict], lang_code: str) -> str:
    """Build a batch translation prompt for multiple strings."""
    lang = LANGUAGE_CONFIG.get(lang_code, {
        'name': lang_code.upper(),
        'instructions': 'Be concise.',
    })

    # Build numbered list of strings to translate
    strings_list = []
    for i, item in enumerate(items, 1):
        key = item['key']
        strings_list.append(f"{i}. {key}")

    strings_text = "\n".join(strings_list)

    prompt = f"""<start_of_turn>user
Translate these UI texts from English to {lang['name']}.

RULES:
- Output ONLY numbered translations, one per line
- Format exactly: "1. translation" (number, dot, space, translation only)
- Keep {{placeholders}} exactly as they appear - do NOT translate them
- Keep slash commands (e.g., /help, /settings, /docs) exactly as they appear - do NOT translate them
- Keep technical terms (API, CLI, JSON, URL, MCP, OAuth, YOLO) unchanged
- {lang['instructions']}
- NO explanations, NO notes, ONLY translations

Texts:
{strings_text}
<end_of_turn>
<start_of_turn>model
"""
    return prompt


def parse_batch_response(response: str, count: int) -> List[Optional[str]]:
    """Parse batch translation response into individual translations."""
    results = [None] * count
    lines = response.strip().split('\n')

    for line in lines:
        line = line.strip()
        if not line:
            continue

        # Try to parse "N. translation" format
        match = re.match(r'^(\d+)\.\s*(.+)$', line)
        if match:
            idx = int(match.group(1)) - 1  # Convert to 0-indexed
            translation = match.group(2).strip()

            # Remove quotes if wrapped
            if (translation.startswith('"') and translation.endswith('"')) or \
               (translation.startswith("'") and translation.endswith("'")):
                translation = translation[1:-1]

            # Remove any stray notes like [keep: ...] or [manter: ...]
            translation = re.sub(r'\s*\[(?:keep|manter|mantener|garder)[^\]]*\]', '', translation, flags=re.IGNORECASE)
            translation = translation.strip()

            # IMPORTANT: Remove any leading "N. " prefix that the model might have included in the translation itself
            # This handles cases where model outputs "1. 1. translation" instead of "1. translation"
            translation = re.sub(r'^(\d+)\.\s*', '', translation)

            if 0 <= idx < count and translation:
                results[idx] = translation

    return results


def validate_translation(original: str, translation: str, params: List[str]) -> tuple[bool, str]:
    """
    Validate that the translation is valid.
    Returns (is_valid, error_message).
    """
    if not translation or not translation.strip():
        return False, "Empty translation"

    # Clean up translation
    translation = translation.strip()

    # Remove any quotes that might have been added
    if translation.startswith('"') and translation.endswith('"'):
        translation = translation[1:-1]
    if translation.startswith("'") and translation.endswith("'"):
        translation = translation[1:-1]

    # Check that all parameters are preserved
    for param in params:
        placeholder = f"{{{param}}}"
        if placeholder in original and placeholder not in translation:
            return False, f"Missing parameter: {placeholder}"

    # Check that no new placeholders were introduced
    original_placeholders = set(re.findall(r'\{[^}]+\}', original))
    translation_placeholders = set(re.findall(r'\{[^}]+\}', translation))

    new_placeholders = translation_placeholders - original_placeholders
    if new_placeholders:
        return False, f"New placeholders introduced: {new_placeholders}"

    # Check translation is not too different in length (sanity check)
    len_ratio = len(translation) / max(len(original), 1)
    if len_ratio > 5 or len_ratio < 0.1:
        return False, f"Suspicious length ratio: {len_ratio:.2f}"

    return True, ""


def clean_translation(text: str) -> str:
    """Clean up the model output to extract just the translation."""
    # Remove any leading/trailing whitespace
    text = text.strip()

    # Take only the first line (model sometimes adds explanations)
    lines = text.split('\n')
    text = lines[0].strip()

    # Remove quotes if wrapped
    if (text.startswith('"') and text.endswith('"')) or \
       (text.startswith("'") and text.endswith("'")):
        text = text[1:-1]

    # Remove common prefixes the model might add
    prefixes_to_remove = [
        "Translation: ",
        "Portuguese: ",
        "Translated: ",
        "Result: ",
        "Output: ",
    ]
    for prefix in prefixes_to_remove:
        if text.lower().startswith(prefix.lower()):
            text = text[len(prefix):]

    return text.strip()


def get_models_dir() -> Path:
    """Get the local models directory (project_root/models/)."""
    # Find project root (where this script is in scripts/)
    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    models_dir = project_root / "models"
    models_dir.mkdir(exist_ok=True)
    return models_dir


def download_model(repo_id: str, filename: str) -> Path:
    """Download model to local models/ folder if not present."""
    from huggingface_hub import hf_hub_download

    models_dir = get_models_dir()
    local_path = models_dir / filename

    if local_path.exists():
        print(f"Model found locally: {local_path}")
        return local_path

    print(f"\nDownloading model to local folder...")
    print(f"  Repo: {repo_id}")
    print(f"  File: {filename}")
    print(f"  Destination: {local_path}")
    print("\nThis may take a while (~16GB for 27B model)...")

    # Download to local folder
    downloaded_path = hf_hub_download(
        repo_id=repo_id,
        filename=filename,
        local_dir=models_dir,
        local_dir_use_symlinks=False,
    )

    print(f"Download complete: {downloaded_path}")
    return Path(downloaded_path)


def load_model(repo_id: str, filename: Optional[str], n_gpu_layers: int, n_ctx: int, verbose: bool):
    """Load the Gemma model via llama-cpp-python."""
    if not HAS_LLAMA:
        raise RuntimeError("llama-cpp-python not installed")

    # Get model config
    config = MODEL_CONFIGS.get(repo_id, {})
    if not filename:
        filename = config.get('filename', 'gemma-3-27b-it-Q4_K_M.gguf')

    # Download to local models/ folder if needed
    local_model_path = download_model(repo_id, filename)

    print(f"\nLoading model: {local_model_path}")
    print(f"GPU layers: {n_gpu_layers} (-1 = all)")
    print(f"Context size: {n_ctx}")

    try:
        llm = Llama(
            model_path=str(local_model_path),
            n_gpu_layers=n_gpu_layers,
            n_ctx=n_ctx,
            verbose=verbose,
        )
        print("Model loaded successfully!")
        return llm
    except Exception as e:
        raise RuntimeError(f"Failed to load model: {e}")


def translate_string(
    llm,
    key: str,
    context: str,
    file: str,
    params: List[str],
    lang_code: str,
    verbose: bool = False
) -> Optional[str]:
    """Translate a single string using the model."""
    prompt = build_prompt(key, context, file, params, lang_code)

    if verbose:
        print(f"\n--- Prompt ---\n{prompt}\n--------------")

    try:
        output = llm(
            prompt,
            max_tokens=256,
            temperature=0.3,
            top_p=0.9,
            stop=["<end_of_turn>", "\n\n"],
            echo=False,
        )

        raw_text = output['choices'][0]['text']
        translation = clean_translation(raw_text)

        if verbose:
            print(f"Raw output: {raw_text}")
            print(f"Cleaned: {translation}")

        # Validate
        is_valid, error = validate_translation(key, translation, params)
        if not is_valid:
            print(f"    Validation failed: {error}")
            return None

        return translation

    except Exception as e:
        print(f"    Error: {e}")
        return None


def translate_batch(
    llm,
    items: List[Dict],
    lang_code: str,
    verbose: bool = False
) -> List[Optional[str]]:
    """Translate a batch of strings using the model."""
    if not items:
        return []

    prompt = build_batch_prompt(items, lang_code)

    if verbose:
        print(f"\n--- Batch Prompt ---\n{prompt}\n--------------")

    try:
        # Calculate max tokens based on batch size (roughly 50 tokens per translation)
        max_tokens = min(len(items) * 100, 1024)

        output = llm(
            prompt,
            max_tokens=max_tokens,
            temperature=0.3,
            top_p=0.9,
            stop=["<end_of_turn>"],
            echo=False,
        )

        raw_text = output['choices'][0]['text']

        if verbose:
            print(f"Raw batch output:\n{raw_text}")

        # Parse the batch response
        translations = parse_batch_response(raw_text, len(items))

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

    except Exception as e:
        print(f"    Batch error: {e}")
        return [None] * len(items)


def main():
    args = parse_args()

    # List models mode
    if args.list_models:
        print("\nAvailable models:")
        print("-" * 60)
        for repo_id, config in MODEL_CONFIGS.items():
            print(f"\n  {repo_id}")
            print(f"    File: {config['filename']}")
            print(f"    Size: {config['size_gb']} GB")
            print(f"    Description: {config['description']}")
        return

    print("\n" + "=" * 60)
    print("I18n Auto-Translation Script (llama.cpp)")
    print("=" * 60)

    # Load input file
    input_path = args.input
    output_path = args.output
    checkpoint_path = get_checkpoint_path(output_path)

    # Handle resume
    if args.resume:
        if os.path.exists(checkpoint_path):
            data = load_json(checkpoint_path)
            if data:
                print(f"Resuming from checkpoint: {checkpoint_path}")
            else:
                print("Checkpoint file is invalid, starting fresh")
                data = load_json(input_path)
        else:
            print("No checkpoint found, starting fresh")
            data = load_json(input_path)
    else:
        data = load_json(input_path)

    if not data:
        print(f"Error: Could not load input file: {input_path}")
        print("\nPlease run the extraction script first:")
        print(f"  node scripts/i18n-extract-strings.cjs --lang={args.lang}")
        sys.exit(1)

    # Load existing translations from locale file
    existing_translations = load_existing_translations(args.lang)
    locale_path = get_locale_path(args.lang)

    # Get translations to process
    translations = data.get('translations', [])

    # If not forcing, mark already translated strings as completed
    skipped_from_locale = 0
    if not args.force and existing_translations:
        for t in translations:
            if not t.get('translation') and t['key'] in existing_translations:
                t['translation'] = existing_translations[t['key']]
                t['_from_locale'] = True  # Mark as pre-existing
                skipped_from_locale += 1

    pending = [t for t in translations if not t.get('translation')]
    completed = [t for t in translations if t.get('translation')]

    print(f"\nInput: {input_path}")
    print(f"Output: {output_path}")
    print(f"Target language: {args.lang}")
    print(f"Locale file: {locale_path}")
    print(f"Model: {args.model}")
    print(f"Force mode: {args.force}")
    print(f"Total strings: {len(translations)}")
    print(f"Already in locale file: {len(existing_translations)}")
    if not args.force:
        print(f"Skipped (already translated): {skipped_from_locale}")
    print(f"Already completed in input: {len(completed) - skipped_from_locale}")
    print(f"Pending translation: {len(pending)}")

    if not pending:
        print("\nAll strings are already translated!")
        save_json(output_path, data)
        print(f"Output saved to: {output_path}")
        return

    # Dry run mode
    if args.dry_run:
        print("\n[DRY RUN] Would translate:")
        for i, item in enumerate(pending[:10]):
            key = item['key']
            print(f"  {i + 1}. \"{key[:50]}{'...' if len(key) > 50 else ''}\"")
        if len(pending) > 10:
            print(f"  ... and {len(pending) - 10} more")
        return

    # Check llama-cpp-python
    if not HAS_LLAMA:
        print("\nError: llama-cpp-python is required.")
        print("Install with CUDA support:")
        print("  pip install llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu121")
        sys.exit(1)

    # Load model
    print("\n" + "-" * 40)
    print("Loading model...")
    print("-" * 40)

    try:
        llm = load_model(
            args.model,
            args.filename,
            args.n_gpu_layers,
            args.n_ctx,
            args.verbose
        )
    except Exception as e:
        print(f"\nFailed to load model: {e}")
        sys.exit(1)

    # Translation loop
    print("\n" + "-" * 40)
    print(f"Starting translation (batch size: {args.batch_size})...")
    print("-" * 40)

    failed = []
    start_time = time.time()
    batch_size = args.batch_size
    total_processed = 0

    # Process in batches
    for batch_start in range(0, len(pending), batch_size):
        batch_end = min(batch_start + batch_size, len(pending))
        batch_items = pending[batch_start:batch_end]

        safe_print(f"\n[Batch {batch_start // batch_size + 1}] Translating {len(batch_items)} strings ({batch_start + 1}-{batch_end} of {len(pending)})...")

        # Show what's in this batch
        for i, item in enumerate(batch_items):
            key_display = item['key'][:40] + '...' if len(item['key']) > 40 else item['key']
            key_display = key_display.replace('\n', '\\n')
            safe_print(f"  {batch_start + i + 1}. \"{key_display}\"")

        # Translate the batch
        translations = translate_batch(llm, batch_items, args.lang, args.verbose)

        # Process results
        batch_failed = 0
        for i, (item, translation) in enumerate(zip(batch_items, translations)):
            if translation:
                item['translation'] = translation
                trans_display = translation[:40] + '...' if len(translation) > 40 else translation
                safe_print(f"  -> {batch_start + i + 1}. \"{trans_display}\"")
            else:
                # Retry single string if batch failed for this item
                safe_print(f"  -> {batch_start + i + 1}. Batch failed, retrying single...")
                single_translation = translate_string(
                    llm, item['key'], item.get('context', 'UI text'),
                    item.get('file', 'unknown'), item.get('params', []),
                    args.lang, args.verbose
                )
                if single_translation:
                    item['translation'] = single_translation
                    trans_display = single_translation[:40] + '...' if len(single_translation) > 40 else single_translation
                    safe_print(f"     Retry OK: \"{trans_display}\"")
                else:
                    failed.append(item['key'])
                    batch_failed += 1
                    safe_print(f"     Retry FAILED")

        total_processed += len(batch_items)

        # Save checkpoint periodically
        if total_processed % args.checkpoint_interval < batch_size:
            print(f"\n  [Checkpoint saved at {total_processed} translations]")
            save_json(checkpoint_path, data)

    # Final save
    elapsed = time.time() - start_time
    save_json(output_path, data)

    # Clean up checkpoint if all successful
    if os.path.exists(checkpoint_path) and not failed:
        os.remove(checkpoint_path)

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
        print("\nYou can manually translate these in the output file.")

    print("\nNext step: Merge translations into locale file:")
    print(f"  node scripts/i18n-merge-translations.cjs --locale={args.lang}")


if __name__ == '__main__':
    main()

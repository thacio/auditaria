/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// WYSIWYG editor support: AST conversions can produce large JSON payloads,
// and the parser writes informational DEBUG lines to stderr on every run —
// success is keyed on the exit code, never on stderr being empty.
const AST_MAX_BUFFER = 64 * 1024 * 1024; // 64MB
const PARSER_ENV = { ...process.env, PYTHONIOENCODING: 'utf-8' };

// Errors that mean "the OS refused to launch this executable" rather than
// "the parser ran and reported a problem". On locked-down machines (e.g.
// corporate Windows Defender / WDAC) the unsigned compiled parser.exe is
// blocked with EPERM/EACCES; ENOENT means a candidate interpreter is absent.
// Any of these triggers a fallback to the next available way to run the parser.
const EXEC_BLOCKED_CODES = new Set(['EPERM', 'EACCES', 'ENOENT']);

/**
 * One concrete way to run the parser. The compiled binary
 * (`parser.exe [args]`) is preferred; the Python source
 * (`python parser.py [args]`) is a fallback for machines where the unsigned
 * binary is blocked from executing but a permitted Python is available.
 */
interface ParserInvoker {
  kind: 'binary' | 'python';
  cmd: string; // the binary path, or the python interpreter command
  prefixArgs: string[]; // [] for the binary, [parser.py path] for python
  cwd?: string; // run python from the source dir (sibling-module imports)
}

/**
 * DOCX Parser Service
 *
 * This service is SPECIFIC to the docx-writing-skill.
 * It finds the parser executable and invokes it.
 *
 * This is NOT generic - it's only for parser.
 *
 * Responsibilities:
 * - Detect if parser executable exists
 * - Track parser availability status
 * - Execute parser binary on markdown files
 * - Handle file-in-use errors
 * - Open generated DOCX with system default application
 */
export class DocxParserService {
  private parserPath: string | null = null;
  private isAvailable: boolean = false;
  // Ordered ways to run the parser (binary first, python fallback second).
  // The index of the one that last ran successfully is tried first next time,
  // so once the binary is found to be blocked we stick with python.
  private invokers: ParserInvoker[] = [];
  private activeInvokerIndex = 0;

  // WYSIWYG editor support (AST bridge). The installed parser may predate
  // the AST flags, so WYSIWYG availability is probed (--emit-spec) instead
  // of assumed from parser presence.
  private wysiwygSupported: boolean | null = null;
  private wysiwygProbePromise: Promise<boolean> | null = null;
  private cachedSpec: unknown | null = null;
  // Incremented by refresh() so an in-flight probe of the OLD binary cannot
  // repopulate the cache after invalidation
  private probeGeneration = 0;

  constructor(private workingDirectory: string) {
    this.detectParser();
  }

  /**
   * Detect parser executable
   *
   * Preferred layout (multi-OS shared folders — e.g. a project on a cloud
   * drive used from Windows AND macOS): each OS keeps its binaries in its
   * own subfolder, so installs coexist:
   *   .auditaria/skills/docx-writing-skill/parser-windows/parser.exe
   *   .auditaria/skills/docx-writing-skill/parser-macos/parser
   *   .auditaria/skills/docx-writing-skill/parser-linux/parser
   * Legacy layout (binary at the skill root) is kept as a fallback so
   * existing installs work until /setup-skill is re-run.
   */
  private detectParser(): void {
    const platform = process.platform;
    const executable = platform === 'win32' ? 'parser.exe' : 'parser';
    const osName =
      platform === 'win32'
        ? 'windows'
        : platform === 'darwin'
          ? 'macos'
          : 'linux';

    const skillDir = path.join(
      this.workingDirectory,
      '.auditaria/skills/docx-writing-skill',
    );

    const invokers: ParserInvoker[] = [];

    // 1) Compiled binary (preferred): fast, self-contained, no Python needed.
    const binaryPath = [
      path.join(skillDir, `parser-${osName}`, executable),
      path.join(skillDir, executable),
    ].find((candidate) => fs.existsSync(candidate));
    if (binaryPath) {
      invokers.push({ kind: 'binary', cmd: binaryPath, prefixArgs: [] });
    }

    // 2) Python source (fallback): used when the unsigned binary is blocked
    // from executing (corporate AV/WDAC) but a permitted Python is present.
    // `python <abs>/parser.py` puts the script's own folder on sys.path[0],
    // so its sibling modules import without depending on the cwd.
    const pythonScript = [
      path.join(skillDir, `parser-${osName}`, 'parser.py'),
      path.join(skillDir, 'parser.py'),
    ].find((candidate) => fs.existsSync(candidate));
    if (pythonScript) {
      const python = this.detectPython();
      if (python) {
        invokers.push({
          kind: 'python',
          cmd: python,
          prefixArgs: [pythonScript],
          cwd: path.dirname(pythonScript),
        });
      }
    }

    this.invokers = invokers;
    this.activeInvokerIndex = 0;
    // Kept for display (footer / parser_status). Prefer the binary path; fall
    // back to the source path so it still reads as a real install.
    this.parserPath = binaryPath ?? pythonScript ?? null;
    this.isAvailable = invokers.length > 0;
  }

  /**
   * Find a usable Python interpreter on PATH, or null if none responds.
   * Only called when a parser.py source is present, so the (synchronous)
   * version probe never runs for ordinary binary-only installs.
   */
  private detectPython(): string | null {
    const candidates =
      process.platform === 'win32'
        ? ['python', 'py', 'python3']
        : ['python3', 'python'];
    for (const cmd of candidates) {
      try {
        execFileSync(cmd, ['--version'], { stdio: 'ignore' });
        return cmd;
      } catch {
        // try the next candidate
      }
    }
    return null;
  }

  /**
   * Run the parser, transparently falling back from the compiled binary to the
   * Python source if the binary is blocked from executing (EPERM/EACCES). The
   * invoker that succeeds is remembered and tried first next time. Optional
   * `input` is written to the child's stdin (for --ast-to-md).
   */
  private async runParser(
    args: string[],
    opts: {
      maxBuffer?: number;
      env?: NodeJS.ProcessEnv;
      input?: string;
    } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    if (this.invokers.length === 0) {
      throw new Error('parser not available');
    }

    // Try the last-known-good invoker first, then the others.
    const order = [
      this.activeInvokerIndex,
      ...this.invokers
        .map((_, i) => i)
        .filter((i) => i !== this.activeInvokerIndex),
    ];

    let lastError: unknown;
    for (let attempt = 0; attempt < order.length; attempt++) {
      const idx = order[attempt];
      const inv = this.invokers[idx];
      try {
        const promise = execFileAsync(inv.cmd, [...inv.prefixArgs, ...args], {
          maxBuffer: opts.maxBuffer,
          env: opts.env,
          cwd: inv.cwd,
        });
        if (opts.input !== undefined) {
          const child = promise.child;
          if (child?.stdin) {
            // EPIPE if the parser exits early — surfaced via the await below
            child.stdin.on('error', () => {});
            child.stdin.write(opts.input, 'utf-8');
            child.stdin.end();
          }
        }
        const { stdout, stderr } = await promise;
        this.activeInvokerIndex = idx;
        return { stdout, stderr };
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? error.code
            : undefined;
        const blocked =
          typeof code === 'string' && EXEC_BLOCKED_CODES.has(code);
        const moreToTry = attempt < order.length - 1;
        if (blocked && moreToTry) {
          lastError = error;
          continue; // binary blocked → try the python fallback
        }
        throw error; // a genuine parser error → let the caller report it
      }
    }
    throw lastError ?? new Error('parser invocation failed');
  }

  /**
   * Check if parser is available
   */
  isParserAvailable(): boolean {
    return this.isAvailable;
  }

  /**
   * Get parser executable path
   */
  getParserPath(): string | null {
    return this.parserPath;
  }

  /**
   * Parse markdown file to DOCX
   *
   * @param mdFilePath Absolute path to markdown file
   * @returns Parse result with success status and output path or error
   */
  async parseMarkdownToDocx(mdFilePath: string): Promise<{
    success: boolean;
    outputPath?: string;
    error?: string;
  }> {
    if (!this.isAvailable || !this.parserPath) {
      return {
        success: false,
        error:
          'DOCX parser not installed. Run: /setup-skill docx-writing-skill [password]',
      };
    }

    // Verify input file exists
    if (!fs.existsSync(mdFilePath)) {
      return {
        success: false,
        error: `Input file not found: ${mdFilePath}`,
      };
    }

    try {
      // Execute the parser on the markdown file (compiled binary, or the
      // python source fallback). It writes output.docx in the same directory.
      await this.runParser([mdFilePath]);

      // Calculate expected output path
      const outputPath = mdFilePath.replace(/\.md$/i, '.docx');

      if (!fs.existsSync(outputPath)) {
        return {
          success: false,
          error: 'Parser executed but output file not found',
        };
      }

      return {
        success: true,
        outputPath,
      };
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Detect file-in-use errors
      if (
        errorMsg.includes('being used by another process') ||
        errorMsg.includes('Permission denied') ||
        errorMsg.includes('EACCES') ||
        errorMsg.includes('EBUSY')
      ) {
        return {
          success: false,
          error:
            'File is currently open in another application. Please close it and try again.',
        };
      }

      return {
        success: false,
        error: `Parser error: ${errorMsg}`,
      };
    }
  }

  /**
   * Refresh parser detection (call after installing skill)
   */
  refresh(): void {
    this.detectParser();
    // Re-probe WYSIWYG support — the installed binary may have changed
    this.probeGeneration++;
    this.wysiwygSupported = null;
    this.wysiwygProbePromise = null;
    this.cachedSpec = null;
  }

  // =========================================================================
  // WYSIWYG editor support (AST bridge to the same parser binary)
  // =========================================================================

  /**
   * Probe whether the installed parser supports the AST subcommands
   * (--emit-spec/--emit-ast/--ast-to-md). Older builds of the binary do not.
   * The successful probe output (the spec) is cached.
   */
  async probeWysiwygSupport(): Promise<boolean> {
    if (!this.isAvailable || !this.parserPath) {
      return false;
    }
    if (this.wysiwygSupported !== null) {
      return this.wysiwygSupported;
    }
    if (this.wysiwygProbePromise) {
      return this.wysiwygProbePromise;
    }

    const generation = this.probeGeneration;
    this.wysiwygProbePromise = (async () => {
      let spec: unknown | null = null;
      let supported = false;
      try {
        const { stdout } = await this.runParser(['--emit-spec'], {
          maxBuffer: AST_MAX_BUFFER,
          env: PARSER_ENV,
        });
        spec = JSON.parse(stdout);
        supported = true;
      } catch {
        supported = false;
      }

      // Discard the result if refresh() invalidated this probe meanwhile
      // (the binary may have been replaced while we were probing it)
      if (generation !== this.probeGeneration) {
        return supported;
      }

      this.cachedSpec = spec;
      this.wysiwygSupported = supported;
      this.wysiwygProbePromise = null;
      return supported;
    })();

    return this.wysiwygProbePromise;
  }

  /**
   * Synchronous view of the last probe result (false until probed).
   */
  isWysiwygSupported(): boolean {
    return this.wysiwygSupported === true;
  }

  /**
   * Get the editor capability manifest (spec) from the parser.
   * Cached after the first successful call.
   */
  async emitSpec(): Promise<{
    success: boolean;
    spec?: unknown;
    error?: string;
  }> {
    if (!this.isAvailable || !this.parserPath) {
      return {
        success: false,
        error:
          'DOCX parser not installed. Run: /setup-skill docx-writing-skill [password]',
      };
    }
    if (this.cachedSpec !== null) {
      return { success: true, spec: this.cachedSpec };
    }

    const supported = await this.probeWysiwygSupport();
    if (!supported || this.cachedSpec === null) {
      return {
        success: false,
        error:
          'Installed parser does not support the WYSIWYG editor (missing --emit-spec). Re-run: /setup-skill docx-writing-skill',
      };
    }
    return { success: true, spec: this.cachedSpec };
  }

  /**
   * Convert markdown content (possibly an unsaved buffer) to the document AST.
   * The content is written to a temp file because --emit-ast takes a file path.
   */
  async mdToAst(content: string): Promise<{
    success: boolean;
    ast?: unknown;
    error?: string;
  }> {
    if (!this.isAvailable || !this.parserPath) {
      return {
        success: false,
        error:
          'DOCX parser not installed. Run: /setup-skill docx-writing-skill [password]',
      };
    }

    const tmpPath = path.join(
      os.tmpdir(),
      `auditaria-wysiwyg-${crypto.randomBytes(8).toString('hex')}.md`,
    );

    try {
      fs.writeFileSync(tmpPath, content, 'utf-8');
      const { stdout } = await this.runParser(['--emit-ast', tmpPath], {
        maxBuffer: AST_MAX_BUFFER,
        env: PARSER_ENV,
      });
      return { success: true, ast: JSON.parse(stdout) };
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { success: false, error: `md→AST conversion failed: ${errorMsg}` };
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* temp file already gone */
      }
    }
  }

  /**
   * Convert a document AST back to markdown.
   * The AST JSON is written to the child's stdin; markdown comes on stdout.
   */
  async astToMd(astJson: string): Promise<{
    success: boolean;
    md?: string;
    error?: string;
  }> {
    if (!this.isAvailable || !this.parserPath) {
      return {
        success: false,
        error:
          'DOCX parser not installed. Run: /setup-skill docx-writing-skill [password]',
      };
    }

    try {
      // The AST JSON goes to the child's stdin; markdown comes back on stdout.
      const { stdout } = await this.runParser(['--ast-to-md'], {
        maxBuffer: AST_MAX_BUFFER,
        env: PARSER_ENV,
        input: astJson,
      });
      return { success: true, md: stdout };
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { success: false, error: `AST→md conversion failed: ${errorMsg}` };
    }
  }

  /**
   * Import a Word document: .docx → .md (plus extracted media next to it).
   * Picks a non-clobbering output path next to the source file.
   */
  async docxToMd(docxPath: string): Promise<{
    success: boolean;
    mdPath?: string;
    error?: string;
  }> {
    if (!this.isAvailable || !this.parserPath) {
      return {
        success: false,
        error:
          'DOCX parser not installed. Run: /setup-skill docx-writing-skill [password]',
      };
    }
    if (!fs.existsSync(docxPath)) {
      return { success: false, error: `Input file not found: ${docxPath}` };
    }

    const base = docxPath.replace(/\.docx$/i, '');
    let outMd = `${base}.md`;
    if (fs.existsSync(outMd)) {
      outMd = `${base}.imported.md`;
    }
    if (fs.existsSync(outMd)) {
      outMd = `${base}.imported-${Date.now()}.md`;
    }

    try {
      await this.runParser(['--docx-to-md', docxPath, '-o', outMd], {
        maxBuffer: AST_MAX_BUFFER,
        env: PARSER_ENV,
      });
      if (!fs.existsSync(outMd)) {
        return {
          success: false,
          error: 'Import executed but the output .md was not found',
        };
      }
      return { success: true, mdPath: outMd };
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { success: false, error: `.docx import failed: ${errorMsg}` };
    }
  }

  /**
   * Open DOCX file with system default application
   *
   * @param docxPath Absolute path to DOCX file
   */
  async openDocxFile(docxPath: string): Promise<void> {
    try {
      // execFile with argument arrays — the path never touches a shell, so
      // filenames containing quotes/$() cannot inject commands
      if (process.platform === 'win32') {
        await execFileAsync('rundll32', [
          'url.dll,FileProtocolHandler',
          docxPath,
        ]);
      } else if (process.platform === 'darwin') {
        await execFileAsync('open', [docxPath]);
      } else {
        await execFileAsync('xdg-open', [docxPath]);
      }
    } catch (error) {
      // Don't throw - opening file is optional convenience feature
      // eslint-disable-next-line no-console
      console.warn(`Failed to open DOCX file: ${error}`);
    }
  }
}

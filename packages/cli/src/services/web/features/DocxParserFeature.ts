/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import type { WebSocket } from 'ws';
import { DocxParserService } from '../../DocxParserService.js';
import { WebFeature } from '../core/webFeature.js';
import type { WebFeatureContext } from '../core/types.js';
import {
  readRequestId,
  readString,
  type ServerMessageType,
} from '../protocol.js';

/** Set to `1` to hide the WYSIWYG editor even when the parser supports it. */
const WYSIWYG_DISABLED_ENV = 'AUDITARIA_WYSIWYG_DISABLED';

type AstOperation = 'ast_spec' | 'md_to_ast' | 'ast_to_md' | 'docx_to_md';

interface ParserResult {
  success: boolean;
  error?: string;
}

/**
 * Markdown → DOCX conversion through the `docx-writing-skill` parser binary,
 * and the AST bridge behind the web WYSIWYG editor (the parser is the ONE
 * renderer: `--emit-spec`, `--emit-ast`, `--ast-to-md`, `--docx-to-md`).
 */
export class DocxParserFeature extends WebFeature {
  readonly name = 'docx-parser';
  private parser: DocxParserService | null = null;

  protected onAttach(ctx: WebFeatureContext): void {
    const parser = new DocxParserService(ctx.workspaceRoot);
    this.parser = parser;

    // Warm the WYSIWYG probe (--emit-spec) so the flag is ready by the time
    // clients connect; push an update once it resolves.
    void parser.probeWysiwygSupport().then(() => this.broadcastParserStatus());

    const { inbound } = ctx;
    inbound.on('parser_status_request', () => this.broadcastParserStatus());
    inbound.on('parse_request', (message) => {
      const path = readString(message, 'path');
      if (path) return this.parseToDocx(path);
    });
    inbound.on('ast_spec_request', (message) =>
      this.bridgeAst(readRequestId(message), 'ast_spec', (p) => p.emitSpec(), {
        type: 'ast_spec_response',
        pick: (r) => ({ spec: r.spec }),
      }),
    );
    inbound.on('md_to_ast_request', (message) => {
      const content = readString(message, 'content');
      if (content === undefined) return;
      return this.bridgeAst(
        readRequestId(message),
        'md_to_ast',
        (p) => p.mdToAst(content),
        { type: 'md_to_ast_response', pick: (r) => ({ ast: r.ast }) },
      );
    });
    inbound.on('ast_to_md_request', (message) => {
      const ast = message['ast'];
      if (ast === undefined) return;
      return this.astToMd(readRequestId(message), ast);
    });
    inbound.on('docx_to_md_request', (message) => {
      const path = readString(message, 'path');
      if (path === undefined) return;
      return this.bridgeAst(
        readRequestId(message),
        'docx_to_md',
        (p) => p.docxToMd(path),
        { type: 'docx_to_md_response', pick: (r) => ({ mdPath: r.mdPath }) },
      );
    });
  }

  protected onDetach(): void {
    this.parser = null;
  }

  override sendInitialState(ws: WebSocket): void {
    const status = this.parserStatus();
    if (status) this.send(ws, 'parser_status', status);
  }

  /**
   * Whether the WYSIWYG markdown editor can be offered: parser installed +
   * binary supports the AST flags + not disabled via env.
   */
  isWysiwygEnabled(): boolean {
    if (process.env[WYSIWYG_DISABLED_ENV] === '1') return false;
    const parser = this.parser;
    return (
      !!parser && parser.isParserAvailable() && parser.isWysiwygSupported()
    );
  }

  broadcastParserStatus(): void {
    const status = this.parserStatus();
    if (status) this.broadcast('parser_status', status);
  }

  /** Re-detects the binary (after `/setup-skill`) and pushes the new status. */
  refreshParserStatus(): void {
    const parser = this.parser;
    if (!parser) return;
    parser.refresh();
    this.broadcastParserStatus();
    // Re-probe the (possibly re-installed) binary; push again when known.
    void parser.probeWysiwygSupport().then(() => this.broadcastParserStatus());
  }

  private parserStatus(): Record<string, unknown> | null {
    const parser = this.parser;
    if (!parser) return null;
    return {
      available: parser.isParserAvailable(),
      path: parser.getParserPath(),
      wysiwyg: this.isWysiwygEnabled(),
    };
  }

  private async parseToDocx(mdPath: string): Promise<void> {
    const parser = this.parser;
    if (!parser) return;
    const result = await parser.parseMarkdownToDocx(mdPath);
    if (result.success && result.outputPath) {
      this.broadcast('parse_response', {
        success: true,
        outputPath: result.outputPath,
        message: 'Successfully parsed to DOCX',
      });
      await parser.openDocxFile(result.outputPath);
    } else {
      this.broadcast('parse_error', {
        success: false,
        error: result.error || 'Unknown error',
      });
    }
  }

  /** WYSIWYG save path: the AST arrives as an object or a JSON string. */
  private astToMd(requestId: string | undefined, ast: unknown): Promise<void> {
    let astJson: string;
    try {
      astJson = typeof ast === 'string' ? ast : JSON.stringify(ast);
    } catch (error) {
      this.sendAstError(
        requestId,
        'ast_to_md',
        `Invalid AST payload: ${error instanceof Error ? error.message : String(error)}`,
      );
      return Promise.resolve();
    }
    return this.bridgeAst(requestId, 'ast_to_md', (p) => p.astToMd(astJson), {
      type: 'ast_to_md_response',
      pick: (r) => ({ md: r.md }),
    });
  }

  /**
   * Shared shape of every AST bridge call: gate on availability, run the
   * parser, answer with the picked fields or an `ast_error` carrying the
   * caller's `requestId`.
   */
  private async bridgeAst<T extends ParserResult>(
    requestId: string | undefined,
    operation: AstOperation,
    run: (parser: DocxParserService) => Promise<T>,
    response: {
      type: ServerMessageType;
      pick: (result: T) => Record<string, unknown>;
    },
  ): Promise<void> {
    const parser = this.parser;
    if (!parser || !this.isWysiwygEnabled()) {
      this.sendAstError(
        requestId,
        operation,
        'WYSIWYG editor is not available',
      );
      return;
    }
    const result = await run(parser);
    if (result.success) {
      this.broadcast(response.type, { requestId, ...response.pick(result) });
    } else {
      this.sendAstError(requestId, operation, result.error || 'Unknown error');
    }
  }

  private sendAstError(
    requestId: string | undefined,
    operation: AstOperation,
    error: string,
  ): void {
    this.broadcast('ast_error', { requestId, operation, error });
  }
}

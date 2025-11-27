/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Babel-based code transformer for i18n
 * Handles AST parsing and transformation
 */

import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import generate from '@babel/generator';
import * as t from '@babel/types';
import { debugLogger } from './debug-logger.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { rebrand } = require('./i18n-rebrand.cjs');

export async function transformCode(source, filePath, options = {}) {
  const { debug = false } = options;

  let modified = false;
  let transformCount = 0;
  let needsTImport = false;
  let needsI18nTextImport = false;
  const transformations = []; // Track detailed transformation info

  try {
    // Parse the source code into AST
    const ast = parse(source, {
      sourceType: 'module',
      plugins: [
        'typescript',
        'jsx',
        'decorators-legacy',
        'classProperties',
        'optionalChaining',
        'nullishCoalescingOperator',
      ],
    });

    // Track if file already has imports
    let hasTranslateImport = false;
    let hasI18nTextImport = false;

    // First pass: Check for existing imports
    traverse.default(ast, {
      ImportDeclaration(path) {
        const source = path.node.source.value;
        if (
          source === '@google/gemini-cli-core' ||
          source === '@thacio/auditaria-cli-core'
        ) {
          for (const spec of path.node.specifiers) {
            if (spec.imported && spec.imported.name === 't') {
              hasTranslateImport = true;
            }
            if (spec.imported && spec.imported.name === 'I18nText') {
              hasI18nTextImport = true;
            }
          }
        }
      },
    });

    // Second pass: Transform the code
    // Use exit to process children before parents
    traverse.default(ast, {
      // Transform JSX Text components: <Text>Hello</Text> or nested Text
      JSXElement: {
        // Use enter phase to catch nested Text BEFORE children are processed
        enter(path) {
          if (!isTextComponent(path.node)) return;

          // Check for nested Text components - transform before children are visited
          if (hasNestedTextComponents(path.node)) {
            // First try full I18nText transformation (for fully static nested Text)
            const result = transformNestedTextComponent(path.node);
            if (result) {
              path.replaceWith(result.node);
              // Skip processing children since we've replaced the entire node
              path.skip();
              modified = true;
              transformCount++;
              needsI18nTextImport = true;
              transformations.push({
                type: 'NestedJSXText',
                original: result.original,
                transformed: `I18nText(${result.original.slice(0, 50)}...)`,
                line: path.node.loc?.start?.line || 0,
              });
              if (debug) {
                debugLogger.debug(
                  `Transformed nested Text component in ${filePath}`,
                );
              }
              return;
            }

            // If full transformation failed (has dynamic expressions),
            // try selective transformation of static children only
            const selectiveResult = transformChildrenSelectively(path.node);
            if (selectiveResult) {
              // Check if it's an object with node (ternary with I18nText) or just a node (t() only)
              const isObjectResult = selectiveResult.node !== undefined;
              const nodeToReplace = isObjectResult
                ? selectiveResult.node
                : selectiveResult;

              path.replaceWith(nodeToReplace);
              path.skip();
              modified = true;
              transformCount++;

              if (isObjectResult && selectiveResult.trueBranchKey) {
                // I18nText transformation (with or without ternary)
                needsI18nTextImport = true;

                if (selectiveResult.falseBranchKey) {
                  // Ternary pattern - add both i18nKeys to transformations
                  transformations.push({
                    type: 'NestedTextWithTernary',
                    original: selectiveResult.trueBranchKey,
                    transformed: `I18nText(${selectiveResult.trueBranchKey.slice(0, 50)}...)`,
                    line: path.node.loc?.start?.line || 0,
                  });
                  transformations.push({
                    type: 'NestedTextWithTernary',
                    original: selectiveResult.falseBranchKey,
                    transformed: `I18nText(${selectiveResult.falseBranchKey.slice(0, 50)}...)`,
                    line: path.node.loc?.start?.line || 0,
                  });
                  transformCount++; // Count as 2 since we have 2 i18nKeys
                } else {
                  // Single I18nText (no ternary, but has params or nested Text)
                  transformations.push({
                    type: selectiveResult.hasParams
                      ? 'I18nTextWithParams'
                      : 'I18nText',
                    original: selectiveResult.trueBranchKey,
                    transformed: `I18nText(${selectiveResult.trueBranchKey.slice(0, 50)}...)`,
                    line: path.node.loc?.start?.line || 0,
                  });
                }
              } else {
                needsTImport = true;
                transformations.push({
                  type: 'PartialNestedJSXText',
                  original: 'mixed static/dynamic content',
                  transformed: 't() for static children only',
                  line: path.node.loc?.start?.line || 0,
                });
              }
              if (debug) {
                debugLogger.debug(
                  `Selectively transformed mixed content in ${filePath}`,
                );
              }
              return;
            }
          }

          // Try selective transformation for simple Text with mixed static/dynamic content
          // (no nested Text, but has ternaries or other dynamic expressions between static text)
          // e.g., <Text>(Use Enter{showTab ? ', Tab' : ''}, Esc)</Text>
          if (hasMixedStaticDynamicContent(path.node)) {
            const mixedResult = transformMixedStaticDynamic(path.node);
            if (mixedResult) {
              path.replaceWith(mixedResult);
              path.skip();
              modified = true;
              transformCount++;
              needsTImport = true;
              transformations.push({
                type: 'MixedStaticDynamic',
                original: 'static text with ternary/dynamic',
                transformed: 't() for static segments',
                line: path.node.loc?.start?.line || 0,
              });
              if (debug) {
                debugLogger.debug(
                  `Transformed mixed static/dynamic content in ${filePath}`,
                );
              }
              return;
            }
          }

          // Try parameterized text transformation (mixed text + expressions)
          // e.g., <Text>Hello {name}</Text> → <Text>{t('Hello {name}', { name })}</Text>
          const paramResult = transformParameterizedText(path.node);
          if (paramResult) {
            path.replaceWith(paramResult.node);
            modified = true;
            transformCount++;
            needsTImport = true;
            transformations.push({
              type: 'ParameterizedText',
              original: paramResult.original,
              params: paramResult.params,
              transformed: `t('${paramResult.original}', { ${paramResult.params.join(', ')} })`,
              line: path.node.loc?.start?.line || 0,
            });
            if (debug) {
              debugLogger.debug(
                `Transformed parameterized Text in ${filePath}`,
              );
            }
            return;
          }

          // Simple text transformation (for Text with only text children)
          const result = transformTextComponent(path.node);
          if (result) {
            path.replaceWith(result.node);
            modified = true;
            transformCount++;
            needsTImport = true;
            transformations.push({
              type: 'JSXText',
              original: result.original,
              transformed: `t('${result.original}')`,
              line: path.node.loc?.start?.line || 0,
            });
            if (debug) {
              debugLogger.debug(`Transformed Text component in ${filePath}`);
            }
          }
        },
      },

      // NOTE: Console.log/error/warn are NOT transformed - they are for development/debugging
      // and can remain in English. Only user-facing JSX Text is transformed.

      // Transform object properties like { title: 'Settings' }
      ObjectProperty(path) {
        const result = transformObjectProperty(path.node);
        if (result) {
          path.replaceWith(result.node);
          modified = true;
          transformCount++;
          needsTImport = true;
          transformations.push({
            type: `property:${result.propertyName}`,
            original: result.original,
            transformed: `t('${result.original}')`,
            line: path.node.loc?.start?.line || 0,
          });
          if (debug) {
            debugLogger.debug(`Transformed object property in ${filePath}`);
          }
        }
      },
    });

    // Add imports if needed and not already present
    if (needsTImport && !hasTranslateImport) {
      addTranslateImport(ast, false);
      modified = true;
    }
    if (needsI18nTextImport && !hasI18nTextImport) {
      addTranslateImport(ast, true);
      modified = true;
    }

    if (modified) {
      // Generate the transformed code
      const output = generate.default(ast, {
        retainLines: false,
        compact: false,
        concise: false,
      });

      return {
        code: output.code,
        modified: true,
        transformCount,
        transformations,
      };
    }
  } catch (error) {
    debugLogger.error(`Failed to transform ${filePath}: ${error.message}`);
    throw error;
  }

  return {
    code: source,
    modified: false,
    transformCount: 0,
    transformations: [],
  };
}

// Helper: Check if node is a Text component
function isTextComponent(node) {
  return (
    node.openingElement &&
    node.openingElement.name &&
    node.openingElement.name.name === 'Text'
  );
}

// Helper: Transform Text component
function transformTextComponent(node) {
  // Only transform if it has simple text children
  if (node.children.length === 1 && t.isJSXText(node.children[0])) {
    const text = node.children[0].value.trim();

    // Skip empty or whitespace-only text
    if (!text) return null;

    // Skip if text looks like a variable or expression
    if (text.startsWith('{') || text.includes('${')) return null;

    const rebrandedText = rebrand(text);

    // Create {t('text')} expression - key is used as fallback automatically
    const tCall = t.callExpression(t.identifier('t'), [
      t.stringLiteral(rebrandedText),
    ]);

    const newChild = t.jsxExpressionContainer(tCall);

    // Create new Text element with transformed children
    return {
      node: t.jsxElement(
        node.openingElement,
        node.closingElement,
        [newChild],
        node.selfClosing,
      ),
      original: rebrandedText,
    };
  }

  return null;
}

// Helper: Transform object property
function transformObjectProperty(node) {
  const propertyNames = [
    'title',
    'label',
    'description',
    'message',
    'placeholder',
    'text',
  ];

  // Check if this is a property we want to transform
  if (t.isIdentifier(node.key) && propertyNames.includes(node.key.name)) {
    // Only transform if value is a string literal
    if (t.isStringLiteral(node.value)) {
      const text = node.value.value;

      // Skip empty or debug-like strings
      if (!text || text.startsWith('DEBUG:') || text.startsWith('[')) {
        return null;
      }

      const rebrandedText = rebrand(text);

      // Create t() call - key is used as fallback automatically
      const tCall = t.callExpression(t.identifier('t'), [
        t.stringLiteral(rebrandedText),
      ]);

      return {
        node: t.objectProperty(node.key, tCall),
        original: rebrandedText,
        propertyName: node.key.name,
      };
    }
  }

  return null;
}

// Helper: Add import for t function and/or I18nText
function addTranslateImport(ast, includeI18nText = false) {
  const specifiers = [t.importSpecifier(t.identifier('t'), t.identifier('t'))];

  if (includeI18nText) {
    specifiers.push(
      t.importSpecifier(t.identifier('I18nText'), t.identifier('I18nText')),
    );
  }

  const importDeclaration = t.importDeclaration(
    specifiers,
    t.stringLiteral('@google/gemini-cli-core'),
  );

  // Add import at the beginning of the file
  ast.program.body.unshift(importDeclaration);
}

// Helper: Check if Text component has nested Text children
function hasNestedTextComponents(node) {
  if (!node.children || node.children.length === 0) return false;

  return node.children.some(
    (child) =>
      t.isJSXElement(child) &&
      child.openingElement &&
      child.openingElement.name &&
      child.openingElement.name.name === 'Text',
  );
}

// Helper: Transform nested Text component to I18nText
function transformNestedTextComponent(node) {
  const extracted = extractNestedContent(node);
  if (!extracted) return null;

  const { templateString, components } = extracted;

  // Skip if template is empty or just whitespace
  if (!templateString || !templateString.trim()) return null;

  // Create the components object: { bold: <Text bold />, ... }
  const componentProperties = Object.entries(components).map(
    ([tagName, componentNode]) => {
      return t.objectProperty(
        t.identifier(tagName),
        componentNode,
        false,
        false,
      );
    },
  );

  // Create I18nText element wrapped in parent Text
  // Use JSX expression container for i18nKey if it contains special characters
  const trimmedTemplate = templateString.trim();
  const needsExpressionContainer =
    trimmedTemplate.includes('"') ||
    trimmedTemplate.includes("'") ||
    trimmedTemplate.includes('\\') ||
    trimmedTemplate.includes('\n');

  const i18nKeyAttribute = needsExpressionContainer
    ? t.jsxAttribute(
        t.jsxIdentifier('i18nKey'),
        t.jsxExpressionContainer(t.stringLiteral(trimmedTemplate)),
      )
    : t.jsxAttribute(
        t.jsxIdentifier('i18nKey'),
        t.stringLiteral(trimmedTemplate),
      );

  const i18nTextElement = t.jsxElement(
    t.jsxOpeningElement(
      t.jsxIdentifier('I18nText'),
      [
        i18nKeyAttribute,
        t.jsxAttribute(
          t.jsxIdentifier('components'),
          t.jsxExpressionContainer(t.objectExpression(componentProperties)),
        ),
      ],
      true, // self-closing
    ),
    null, // no closing element (self-closing)
    [],
    true, // self-closing
  );

  // Wrap I18nText in the parent Text element to preserve styling and ensure
  // all text is inside a Text component (required by Ink)
  const wrappedElement = t.jsxElement(
    t.jsxOpeningElement(
      t.jsxIdentifier('Text'),
      node.openingElement.attributes, // Preserve parent Text's attributes (color, etc.)
      false,
    ),
    t.jsxClosingElement(t.jsxIdentifier('Text')),
    [i18nTextElement],
    false,
  );

  return {
    node: wrappedElement,
    original: templateString.trim(),
  };
}

// Helper: Check if children contain dynamic expressions we can't handle
function hasDynamicExpressions(children) {
  for (const child of children) {
    if (t.isJSXExpressionContainer(child)) {
      // Allow string literals like {' '} but not variables/expressions
      if (!t.isStringLiteral(child.expression)) {
        return true;
      }
    } else if (
      t.isJSXElement(child) &&
      child.openingElement?.name?.name === 'Text'
    ) {
      // Recursively check nested Text children
      if (hasDynamicExpressions(child.children)) {
        return true;
      }
    }
  }
  return false;
}

// Helper: Check if a Text element has ONLY static content (no dynamic expressions)
function isStaticTextComponent(node) {
  if (!t.isJSXElement(node)) return false;
  if (node.openingElement?.name?.name !== 'Text') return false;
  if (!node.children || node.children.length === 0) return false;

  return node.children.every((child) => {
    if (t.isJSXText(child)) return true;
    if (t.isJSXExpressionContainer(child)) {
      // Only allow string literals like {' '}
      return t.isStringLiteral(child.expression);
    }
    // Recursively check nested Text
    if (t.isJSXElement(child) && child.openingElement?.name?.name === 'Text') {
      return isStaticTextComponent(child);
    }
    return false;
  });
}

// Helper: Transform a static Text child to wrap content in t()
function transformSimpleTextChild(node) {
  // Extract all text content from the children
  let textContent = '';
  for (const child of node.children) {
    if (t.isJSXText(child)) {
      textContent += child.value;
    } else if (
      t.isJSXExpressionContainer(child) &&
      t.isStringLiteral(child.expression)
    ) {
      textContent += child.expression.value;
    } else if (
      t.isJSXElement(child) &&
      child.openingElement?.name?.name === 'Text'
    ) {
      // Recursively extract from nested Text
      textContent += extractTextContent(child.children);
    }
  }

  textContent = textContent.replace(/\s+/g, ' ').trim();

  // Skip if empty or too short
  if (!textContent || textContent.length < 2) return null;

  // Create {t('text')} expression
  const tCall = t.jsxExpressionContainer(
    t.callExpression(t.identifier('t'), [t.stringLiteral(textContent)]),
  );

  return t.jsxElement(
    node.openingElement,
    node.closingElement,
    [tCall],
    node.selfClosing,
  );
}

/**
 * Transform children selectively using unified analysis
 * Handles: nested Text + ternary, variables + nested Text, and more complex patterns
 * STRATEGY: Use analyzeJSXContent to determine best transformation approach
 */
function transformChildrenSelectively(node) {
  const analysis = analyzeJSXContent(node.children);
  const strategy = getTransformStrategy(analysis);

  // GRACEFUL FALLBACK: Don't transform patterns we can't handle cleanly
  if (strategy.strategy === 'skip') {
    debugLogger.debug(
      `transformChildrenSelectively: skipping - ${strategy.reason}`,
    );
    return null;
  }

  // Strategy: branched_i18ntext or branched_i18ntext_with_params
  // (ternary + nested Text, with or without variables)
  if (
    strategy.strategy === 'branched_i18ntext' ||
    strategy.strategy === 'branched_i18ntext_with_params'
  ) {
    const result = transformNestedTextWithTernary(node);
    if (result) return result;
  }

  // Strategy: i18ntext_with_params (variables + nested Text, no ternary)
  // e.g., <Text>{count} items in <Text bold>cart</Text></Text>
  if (strategy.strategy === 'i18ntext_with_params') {
    const built = buildTemplateFromAnalysis(analysis, node.children, true);
    if (
      built.templateString &&
      built.templateString.length >= 2 &&
      /[a-zA-Z]/.test(built.templateString)
    ) {
      const i18nTextElement = createI18nTextElement(
        built.templateString,
        built.components,
        node.openingElement.attributes,
        built.params,
      );
      return {
        node: i18nTextElement,
        trueBranchKey: built.templateString,
        hasParams: Object.keys(built.params).length > 0,
      };
    }
  }

  // Strategy: i18ntext (static nested Text, no vars, no ternary)
  // This is already handled by transformNestedTextComponent, but as a fallback...
  if (strategy.strategy === 'i18ntext') {
    // Let the existing transformNestedTextComponent handle it
    return null;
  }

  // Fallback: Original approach for cases without ternary
  // This path handles static nested Text without ternaries
  let anyTransformed = false;
  const newChildren = [];

  // Group consecutive static children (JSXText, string literals, static nested Text)
  // and wrap them together in a single t() call
  let staticGroup = [];
  let staticGroupHasTranslatableText = false;

  function flushStaticGroup() {
    if (staticGroup.length === 0) return;

    // Extract text content from the static group
    let textContent = '';
    for (const item of staticGroup) {
      if (t.isJSXText(item)) {
        textContent += item.value;
      } else if (
        t.isJSXExpressionContainer(item) &&
        t.isStringLiteral(item.expression)
      ) {
        textContent += item.expression.value;
      } else if (
        t.isJSXElement(item) &&
        item.openingElement?.name?.name === 'Text'
      ) {
        // For nested Text, extract content but keep the element structure
        // This is handled separately below
      }
    }

    const trimmedText = textContent.replace(/\s+/g, ' ').trim();

    // Only wrap if there's meaningful text to translate (not just whitespace/punctuation)
    if (
      staticGroupHasTranslatableText &&
      trimmedText.length >= 2 &&
      /[a-zA-Z]/.test(trimmedText)
    ) {
      // Wrap the text content in t()
      const tCall = t.jsxExpressionContainer(
        t.callExpression(t.identifier('t'), [t.stringLiteral(trimmedText)]),
      );
      newChildren.push(tCall);
      anyTransformed = true;
    } else {
      // Keep original children
      newChildren.push(...staticGroup);
    }

    staticGroup = [];
    staticGroupHasTranslatableText = false;
  }

  for (const child of node.children) {
    if (t.isJSXText(child)) {
      // Plain text - add to static group
      const text = child.value.trim();
      if (text.length > 0 && /[a-zA-Z]/.test(text)) {
        staticGroupHasTranslatableText = true;
      }
      staticGroup.push(child);
    } else if (
      t.isJSXExpressionContainer(child) &&
      t.isStringLiteral(child.expression)
    ) {
      // String literal like {' '} - add to static group
      staticGroup.push(child);
    } else if (
      t.isJSXElement(child) &&
      child.openingElement?.name?.name === 'Text'
    ) {
      // Nested Text component
      if (isStaticTextComponent(child)) {
        // Static nested Text - flush current group and transform this separately
        flushStaticGroup();
        const transformed = transformSimpleTextChild(child);
        if (transformed) {
          newChildren.push(transformed);
          anyTransformed = true;
        } else {
          newChildren.push(child);
        }
      } else {
        // Dynamic nested Text - flush group and keep as-is
        flushStaticGroup();
        newChildren.push(child);
      }
    } else {
      // Dynamic expression (ternary, variable, etc.) - flush static group and keep as-is
      flushStaticGroup();
      newChildren.push(child);
    }
  }

  // Flush any remaining static content
  flushStaticGroup();

  if (!anyTransformed) return null;

  return t.jsxElement(
    node.openingElement,
    node.closingElement,
    newChildren,
    node.selfClosing,
  );
}

// ============================================================================
// UNIFIED CONTENT ANALYSIS SYSTEM
// Analyzes JSX children to determine the best transformation strategy
// ============================================================================

// Configuration: Maximum number of branches to generate (2^N where N = number of ternaries)
const MAX_TERNARY_BRANCHES = 8; // Supports up to 3 ternaries (2^3 = 8 branches)

/**
 * Flatten a nested ternary into an array of {condition, value} pairs
 * E.g., a ? (b ? 'X' : 'Y') : 'Z' becomes:
 * [
 *   { conditions: [a, b], value: 'X' },
 *   { conditions: [a, !b], value: 'Y' },
 *   { conditions: [!a], value: 'Z' }
 * ]
 */
function flattenNestedTernary(expr, parentConditions = []) {
  if (!t.isConditionalExpression(expr)) {
    // Base case: not a ternary, this is a leaf value
    return [{ conditions: parentConditions, value: expr }];
  }

  const branches = [];

  // True branch: add current condition
  const trueConditions = [
    ...parentConditions,
    { test: expr.test, negated: false },
  ];
  if (t.isConditionalExpression(expr.consequent)) {
    branches.push(...flattenNestedTernary(expr.consequent, trueConditions));
  } else {
    branches.push({ conditions: trueConditions, value: expr.consequent });
  }

  // False branch: add negated condition
  const falseConditions = [
    ...parentConditions,
    { test: expr.test, negated: true },
  ];
  if (t.isConditionalExpression(expr.alternate)) {
    branches.push(...flattenNestedTernary(expr.alternate, falseConditions));
  } else {
    branches.push({ conditions: falseConditions, value: expr.alternate });
  }

  return branches;
}

/**
 * Check if all branches of a nested ternary are string literals
 */
function isNestedTernarySimple(expr) {
  if (!t.isConditionalExpression(expr)) {
    return t.isStringLiteral(expr);
  }
  return (
    isNestedTernarySimple(expr.consequent) &&
    isNestedTernarySimple(expr.alternate)
  );
}

/**
 * Count total branches in a nested ternary
 */
function countNestedTernaryBranches(expr) {
  if (!t.isConditionalExpression(expr)) {
    return 1;
  }
  return (
    countNestedTernaryBranches(expr.consequent) +
    countNestedTernaryBranches(expr.alternate)
  );
}

/**
 * Analyzes JSX children to classify content types
 * @param {Array} children - JSX children array
 * @returns {Object} Analysis result with classified content
 */
function analyzeJSXContent(children) {
  const analysis = {
    staticText: [], // Plain text segments
    variables: [], // Identifier expressions { name, expr }
    ternaries: [], // Conditional expressions { test, consequent, alternate, isSimple }
    nestedText: [], // Nested Text elements { element, tagName }
    stringLiterals: [], // String literal expressions like {' '}
    hasComplexDynamic: false, // Flags unsupported patterns
    complexReason: null, // Why it's complex (for debugging)
    totalBranches: 1, // Total number of branches needed (2^N for N ternaries)
  };

  const componentCounter = {};

  for (const child of children) {
    if (t.isJSXText(child)) {
      const text = child.value;
      if (text.trim()) {
        analysis.staticText.push({ type: 'jsxText', value: text, node: child });
      } else if (text) {
        // Whitespace-only, still track for template building
        analysis.stringLiterals.push({ value: text, node: child });
      }
    } else if (t.isJSXExpressionContainer(child)) {
      const expr = child.expression;

      if (t.isStringLiteral(expr)) {
        analysis.stringLiterals.push({ value: expr.value, node: child });
      } else if (t.isIdentifier(expr)) {
        analysis.variables.push({ name: expr.name, expr, node: child });
      } else if (t.isMemberExpression(expr) || t.isCallExpression(expr)) {
        // Complex variable expression like user.name or items.length.toLocaleString()
        const paramName = getParamName(expr, {});
        analysis.variables.push({ name: paramName, expr, node: child });
      } else if (t.isConditionalExpression(expr)) {
        const isNestedTernary =
          t.isConditionalExpression(expr.consequent) ||
          t.isConditionalExpression(expr.alternate);
        const nestedBranchCount = isNestedTernary
          ? countNestedTernaryBranches(expr)
          : 2;

        const ternary = {
          test: expr.test,
          consequent: expr.consequent,
          alternate: expr.alternate,
          node: child,
          isSimple:
            t.isStringLiteral(expr.consequent) &&
            t.isStringLiteral(expr.alternate),
          isNestedTernary,
          isNestedTernarySimple: isNestedTernary
            ? isNestedTernarySimple(expr)
            : false,
          flattenedBranches: isNestedTernary
            ? flattenNestedTernary(expr)
            : null,
          branchCount: nestedBranchCount,
        };

        analysis.ternaries.push(ternary);
        analysis.totalBranches *= nestedBranchCount;
      } else if (t.isLogicalExpression(expr)) {
        // && or || expressions - too complex
        analysis.hasComplexDynamic = true;
        analysis.complexReason = 'logical expression';
      } else if (!t.isJSXEmptyExpression(expr)) {
        // Unknown expression type
        analysis.hasComplexDynamic = true;
        analysis.complexReason = `unknown expression: ${expr.type}`;
      }
    } else if (
      t.isJSXElement(child) &&
      child.openingElement?.name?.name === 'Text'
    ) {
      // Check if nested Text has dynamic expressions inside it
      // If so, we can't transform it with I18nText (which only handles static content)
      if (hasDynamicExpressions(child.children)) {
        analysis.hasComplexDynamic = true;
        analysis.complexReason = 'nested Text with dynamic expressions';
        continue;
      }

      const tagBaseName = generateTagName(child.openingElement.attributes);
      componentCounter[tagBaseName] = (componentCounter[tagBaseName] || 0) + 1;
      const tagName =
        componentCounter[tagBaseName] > 1
          ? `${tagBaseName}${componentCounter[tagBaseName] - 1}`
          : tagBaseName;

      analysis.nestedText.push({
        element: child,
        tagName,
        innerContent: extractTextContent(child.children),
        attributes: child.openingElement.attributes,
      });
    } else if (t.isJSXElement(child)) {
      // Non-Text JSX element - too complex
      analysis.hasComplexDynamic = true;
      analysis.complexReason = `non-Text JSX element: ${child.openingElement?.name?.name || 'unknown'}`;
    }
  }

  // Check if we exceed the branch limit
  if (analysis.totalBranches > MAX_TERNARY_BRANCHES) {
    analysis.hasComplexDynamic = true;
    analysis.complexReason = `too many branches (${analysis.totalBranches} > ${MAX_TERNARY_BRANCHES})`;
  }

  // Check if all ternaries are simple (string literal branches)
  const allTernariesSimple = analysis.ternaries.every(
    (ter) => ter.isSimple || (ter.isNestedTernary && ter.isNestedTernarySimple),
  );
  if (analysis.ternaries.length > 0 && !allTernariesSimple) {
    // Check if non-simple ternaries have JSX branches (with nested Text)
    if (analysis.nestedText.length > 0) {
      const hasJSXBranches = analysis.ternaries.some(
        (ter) =>
          t.isJSXElement(ter.consequent) || t.isJSXElement(ter.alternate),
      );
      if (hasJSXBranches) {
        analysis.hasComplexDynamic = true;
        analysis.complexReason = 'ternary with JSX branches';
      }
    }
  }

  return analysis;
}

/**
 * Determines if and how to transform based on analysis
 * @param {Object} analysis - Result from analyzeJSXContent
 * @returns {Object} Strategy recommendation
 */
function getTransformStrategy(analysis) {
  const {
    staticText,
    variables,
    ternaries,
    nestedText,
    hasComplexDynamic,
    complexReason,
    totalBranches,
  } = analysis;

  const hasStatic = staticText.length > 0;
  const hasVars = variables.length > 0;
  const hasSingleTernary = ternaries.length === 1;
  const hasMultipleTernaries = ternaries.length > 1;
  const hasNested = nestedText.length > 0;

  // Check if ternaries are "simple" (all string literal branches, including nested)
  const allTernariesSimple = ternaries.every(
    (ter) => ter.isSimple || (ter.isNestedTernary && ter.isNestedTernarySimple),
  );

  // If too complex, don't transform
  if (hasComplexDynamic) {
    return { strategy: 'skip', reason: complexReason };
  }

  // Only static text, no nesting
  if (hasStatic && !hasVars && ternaries.length === 0 && !hasNested) {
    return { strategy: 'simple_t' };
  }

  // Only static + nested Text (no vars, no ternary)
  if (hasStatic && !hasVars && ternaries.length === 0 && hasNested) {
    return { strategy: 'i18ntext' };
  }

  // Static + variables (no ternary, no nested)
  if (hasStatic && hasVars && ternaries.length === 0 && !hasNested) {
    return { strategy: 'parameterized_t' };
  }

  // Static + vars + nested Text (no ternary) - I18nText with params
  if (hasStatic && hasVars && ternaries.length === 0 && hasNested) {
    return { strategy: 'i18ntext_with_params' };
  }

  // ============================================================================
  // Single ternary strategies (simple or nested ternary that's simple)
  // ============================================================================

  // Static + single simple ternary (no vars, no nested)
  if (
    hasStatic &&
    !hasVars &&
    hasSingleTernary &&
    !hasNested &&
    allTernariesSimple
  ) {
    // Check if it's a nested ternary that needs multi-branch handling
    if (ternaries[0].isNestedTernary) {
      return { strategy: 'multi_branched_t', branches: totalBranches };
    }
    return { strategy: 'branched_t' };
  }

  // Static + single simple ternary + nested Text (no vars)
  if (
    hasStatic &&
    !hasVars &&
    hasSingleTernary &&
    hasNested &&
    allTernariesSimple
  ) {
    if (ternaries[0].isNestedTernary) {
      return { strategy: 'multi_branched_i18ntext', branches: totalBranches };
    }
    return { strategy: 'branched_i18ntext' };
  }

  // Static + vars + single simple ternary (no nested)
  if (
    hasStatic &&
    hasVars &&
    hasSingleTernary &&
    !hasNested &&
    allTernariesSimple
  ) {
    if (ternaries[0].isNestedTernary) {
      return {
        strategy: 'multi_branched_parameterized_t',
        branches: totalBranches,
      };
    }
    return { strategy: 'branched_parameterized_t' };
  }

  // Static + vars + single simple ternary + nested Text
  if (
    hasStatic &&
    hasVars &&
    hasSingleTernary &&
    hasNested &&
    allTernariesSimple
  ) {
    if (ternaries[0].isNestedTernary) {
      return {
        strategy: 'multi_branched_i18ntext_with_params',
        branches: totalBranches,
      };
    }
    return { strategy: 'branched_i18ntext_with_params' };
  }

  // ============================================================================
  // Multiple ternaries strategies (combinatorial branches)
  // ============================================================================

  // Static + multiple simple ternaries (no vars, no nested)
  if (
    hasStatic &&
    !hasVars &&
    hasMultipleTernaries &&
    !hasNested &&
    allTernariesSimple
  ) {
    return { strategy: 'multi_branched_t', branches: totalBranches };
  }

  // Static + multiple simple ternaries + nested Text (no vars)
  if (
    hasStatic &&
    !hasVars &&
    hasMultipleTernaries &&
    hasNested &&
    allTernariesSimple
  ) {
    return { strategy: 'multi_branched_i18ntext', branches: totalBranches };
  }

  // Static + vars + multiple simple ternaries (no nested)
  if (
    hasStatic &&
    hasVars &&
    hasMultipleTernaries &&
    !hasNested &&
    allTernariesSimple
  ) {
    return {
      strategy: 'multi_branched_parameterized_t',
      branches: totalBranches,
    };
  }

  // Static + vars + multiple simple ternaries + nested Text
  if (
    hasStatic &&
    hasVars &&
    hasMultipleTernaries &&
    hasNested &&
    allTernariesSimple
  ) {
    return {
      strategy: 'multi_branched_i18ntext_with_params',
      branches: totalBranches,
    };
  }

  // Fallback: don't transform if we can't handle it cleanly
  return { strategy: 'skip', reason: 'unsupported pattern combination' };
}

// ============================================================================
// Nested Text + Ternary Transformation (Pattern 2)
// Handles: <Text>{cond ? '4.' : '3.'} <Text bold>/help</Text> for more info.</Text>
// Strategy: Create complete sentences for each ternary branch using I18nText
// Output: {cond ? <I18nText i18nKey="4. <bold>/help</bold> for more info." .../> : <I18nText .../>}
// ============================================================================

/**
 * Build template string from analysis for a specific ternary branch
 * Handles: static text, variables, ternary values, nested Text
 * @param {Object} analysis - Result from analyzeJSXContent
 * @param {Array} children - Original children array (for ordering)
 * @param {boolean} useTrueBranch - Which ternary branch to use
 * @returns {Object} { templateString, components, params }
 */
function buildTemplateFromAnalysis(analysis, children, useTrueBranch) {
  let templateString = '';
  const components = {};
  const params = {};
  const componentCounter = {};
  const usedParamNames = {};

  for (const child of children) {
    if (t.isJSXText(child)) {
      let text = child.value.replace(/\s+/g, ' ');
      if (templateString.endsWith(' ') && text.startsWith(' ')) {
        text = text.slice(1);
      }
      templateString += text;
    } else if (t.isJSXExpressionContainer(child)) {
      const expr = child.expression;

      if (t.isStringLiteral(expr)) {
        const spacer = expr.value;
        if (!(templateString.endsWith(' ') && spacer === ' ')) {
          templateString += spacer;
        }
      } else if (t.isIdentifier(expr)) {
        // Variable - add as parameter placeholder
        const paramName = expr.name;
        templateString += `{${paramName}}`;
        params[paramName] = expr;
        usedParamNames[paramName] = true;
      } else if (t.isMemberExpression(expr) || t.isCallExpression(expr)) {
        // Complex expression - generate param name
        const paramName = getParamName(expr, usedParamNames);
        templateString += `{${paramName}}`;
        params[paramName] = expr;
      } else if (t.isConditionalExpression(expr)) {
        // Ternary - pick the appropriate branch value
        const branch = useTrueBranch ? expr.consequent : expr.alternate;
        if (t.isStringLiteral(branch)) {
          templateString += branch.value;
        }
        // Non-string branches are already flagged as complex in analysis
      }
    } else if (
      t.isJSXElement(child) &&
      child.openingElement?.name?.name === 'Text'
    ) {
      const tagBaseName = generateTagName(child.openingElement.attributes);
      componentCounter[tagBaseName] = (componentCounter[tagBaseName] || 0) + 1;
      const tagName =
        componentCounter[tagBaseName] > 1
          ? `${tagBaseName}${componentCounter[tagBaseName] - 1}`
          : tagBaseName;

      const innerContent = extractTextContent(child.children);
      templateString += `<${tagName}>${innerContent}</${tagName}>`;

      components[tagName] = t.jsxElement(
        t.jsxOpeningElement(
          t.jsxIdentifier('Text'),
          child.openingElement.attributes,
          true,
        ),
        null,
        [],
        true,
      );
    }
  }

  // Normalize template string
  templateString = templateString
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.:;!?)])/g, '$1')
    .replace(/([([])\s+/g, '$1')
    .trim();

  templateString = rebrand(templateString);

  return { templateString, components, params };
}

/**
 * Create an I18nText element for a given template, components, and optional params
 * @param {string} templateString - The i18n key template
 * @param {Object} components - Component mapping for nested Text
 * @param {Array} parentAttributes - Parent Text element attributes
 * @param {Object} params - Optional parameters for interpolation (e.g., {icon, count})
 * @returns {JSXElement} The wrapped I18nText element
 */
function createI18nTextElement(
  templateString,
  components,
  parentAttributes,
  params = {},
) {
  const attributes = [];

  // Handle special characters in template
  const needsExpressionContainer =
    templateString.includes('"') ||
    templateString.includes("'") ||
    templateString.includes('\\') ||
    templateString.includes('\n');

  const i18nKeyAttribute = needsExpressionContainer
    ? t.jsxAttribute(
        t.jsxIdentifier('i18nKey'),
        t.jsxExpressionContainer(t.stringLiteral(templateString)),
      )
    : t.jsxAttribute(
        t.jsxIdentifier('i18nKey'),
        t.stringLiteral(templateString),
      );
  attributes.push(i18nKeyAttribute);

  // Add components attribute if we have any
  if (Object.keys(components).length > 0) {
    const componentProperties = Object.entries(components).map(
      ([tagName, componentNode]) => {
        return t.objectProperty(
          t.identifier(tagName),
          componentNode,
          false,
          false,
        );
      },
    );
    attributes.push(
      t.jsxAttribute(
        t.jsxIdentifier('components'),
        t.jsxExpressionContainer(t.objectExpression(componentProperties)),
      ),
    );
  }

  // Add params attribute if we have any
  if (Object.keys(params).length > 0) {
    const paramProperties = Object.entries(params).map(([key, valueExpr]) => {
      const isShorthand = t.isIdentifier(valueExpr) && valueExpr.name === key;
      return t.objectProperty(t.identifier(key), valueExpr, false, isShorthand);
    });
    attributes.push(
      t.jsxAttribute(
        t.jsxIdentifier('params'),
        t.jsxExpressionContainer(t.objectExpression(paramProperties)),
      ),
    );
  }

  const i18nTextElement = t.jsxElement(
    t.jsxOpeningElement(t.jsxIdentifier('I18nText'), attributes, true),
    null,
    [],
    true,
  );

  // Wrap in parent Text to preserve styling
  return t.jsxElement(
    t.jsxOpeningElement(t.jsxIdentifier('Text'), parentAttributes, false),
    t.jsxClosingElement(t.jsxIdentifier('Text')),
    [i18nTextElement],
    false,
  );
}

/**
 * Transform nested Text with ternary to complete sentences per branch
 * Uses unified analysis for robust handling of variables, nested Text, and graceful fallback
 */
function transformNestedTextWithTernary(node) {
  // Use unified analysis to understand content
  const analysis = analyzeJSXContent(node.children);
  const strategy = getTransformStrategy(analysis);

  // GRACEFUL FALLBACK: If pattern is too complex, return null (don't transform)
  if (strategy.strategy === 'skip') {
    debugLogger.debug(`Skipping complex pattern: ${strategy.reason}`);
    return null;
  }

  // Must have exactly one ternary for this transformation
  if (analysis.ternaries.length !== 1) {
    return null;
  }

  const ternary = analysis.ternaries[0];
  const condition = ternary.test;

  // Build templates for each branch using unified builder
  const trueBranch = buildTemplateFromAnalysis(analysis, node.children, true);
  if (!trueBranch.templateString || trueBranch.templateString.length < 2)
    return null;
  if (!/[a-zA-Z]/.test(trueBranch.templateString)) return null;

  const falseBranch = buildTemplateFromAnalysis(analysis, node.children, false);
  if (!falseBranch.templateString || falseBranch.templateString.length < 2)
    return null;
  if (!/[a-zA-Z]/.test(falseBranch.templateString)) return null;

  // Create I18nText elements for each branch (now with params support!)
  const trueI18nText = createI18nTextElement(
    trueBranch.templateString,
    trueBranch.components,
    node.openingElement.attributes,
    trueBranch.params, // Pass params for variables like {icon}, {count}
  );
  const falseI18nText = createI18nTextElement(
    falseBranch.templateString,
    falseBranch.components,
    node.openingElement.attributes,
    falseBranch.params,
  );

  // Create: {condition ? <Text>...</Text> : <Text>...</Text>}
  const ternaryExpression = t.conditionalExpression(
    condition,
    trueI18nText,
    falseI18nText,
  );

  // Return a Fragment (<></>) containing the ternary to maintain JSXElement type
  const fragmentNode = t.jsxFragment(
    t.jsxOpeningFragment(),
    t.jsxClosingFragment(),
    [t.jsxExpressionContainer(ternaryExpression)],
  );

  // Return object with node and i18nKeys for reporting
  return {
    node: fragmentNode,
    trueBranchKey: trueBranch.templateString,
    falseBranchKey: falseBranch.templateString,
    hasParams: Object.keys(trueBranch.params).length > 0,
  };
}

// Helper: Extract content from nested Text structure
function extractNestedContent(node) {
  // Skip if there are dynamic expressions we can't handle
  if (hasDynamicExpressions(node.children)) {
    return null;
  }

  let templateString = '';
  const components = {};
  const componentCounter = {};

  function processChildren(children) {
    for (const child of children) {
      if (t.isJSXText(child)) {
        // Regular text - normalize multiple whitespace but keep single spaces
        let text = child.value.replace(/\s+/g, ' ');
        // Avoid double spaces: if template ends with space and text starts with space
        if (templateString.endsWith(' ') && text.startsWith(' ')) {
          text = text.slice(1);
        }
        templateString += text;
      } else if (t.isJSXExpressionContainer(child)) {
        // Handle {' '} spacers - only add if not already ending with space
        if (t.isStringLiteral(child.expression)) {
          const spacer = child.expression.value;
          if (!(templateString.endsWith(' ') && spacer === ' ')) {
            templateString += spacer;
          }
        }
      } else if (
        t.isJSXElement(child) &&
        child.openingElement &&
        child.openingElement.name &&
        child.openingElement.name.name === 'Text'
      ) {
        // Nested Text component
        const tagBaseName = generateTagName(child.openingElement.attributes);

        // Get unique tag name
        componentCounter[tagBaseName] =
          (componentCounter[tagBaseName] || 0) + 1;
        const tagName =
          componentCounter[tagBaseName] > 1
            ? `${tagBaseName}${componentCounter[tagBaseName] - 1}`
            : tagBaseName;

        // Extract inner text content (recursively handles nested elements)
        const innerContent = extractTextContent(child.children);

        templateString += `<${tagName}>${innerContent}</${tagName}>`;

        // Create the component JSX element (without children, just props)
        components[tagName] = t.jsxElement(
          t.jsxOpeningElement(
            t.jsxIdentifier('Text'),
            child.openingElement.attributes,
            true, // self-closing
          ),
          null,
          [],
          true,
        );
      }
    }
  }

  processChildren(node.children);

  // Final cleanup: collapse any remaining multiple spaces and fix punctuation
  let normalized = templateString
    .replace(/\s+/g, ' ') // Collapse multiple whitespace to single space
    .replace(/\s+:/g, ':') // Remove space before colon
    .replace(/\s+\)/g, ')') // Remove space before closing paren
    .replace(/\(\s+/g, '(') // Remove space after opening paren
    .trim();

  normalized = rebrand(normalized);

  return { templateString: normalized, components };
}

// Helper: Extract plain text content from children (for inner content)
function extractTextContent(children) {
  let text = '';

  for (const child of children) {
    if (t.isJSXText(child)) {
      text += child.value.replace(/\s+/g, ' ');
    } else if (t.isJSXExpressionContainer(child)) {
      if (t.isStringLiteral(child.expression)) {
        text += child.expression.value;
      }
      // Dynamic expressions will be caught by hasDynamicExpressions
    } else if (
      t.isJSXElement(child) &&
      child.openingElement &&
      child.openingElement.name &&
      child.openingElement.name.name === 'Text'
    ) {
      // Nested nested Text - just extract the text content
      text += extractTextContent(child.children);
    }
  }

  return text.trim();
}

// Helper: Generate semantic tag name based on props
function generateTagName(attributes) {
  if (!attributes || attributes.length === 0) return 'styled';

  for (const attr of attributes) {
    if (!t.isJSXAttribute(attr)) continue;

    const attrName = attr.name && attr.name.name;

    // Check for boolean attributes (bold, italic, etc.)
    if (attrName === 'bold' && (!attr.value || attr.value === null)) {
      return 'bold';
    }
    if (attrName === 'italic' && (!attr.value || attr.value === null)) {
      return 'italic';
    }
    if (attrName === 'dimColor' && (!attr.value || attr.value === null)) {
      return 'dim';
    }
    if (attrName === 'underline' && (!attr.value || attr.value === null)) {
      return 'underline';
    }

    // Check for color attribute
    if (attrName === 'color') {
      return 'accent';
    }
  }

  return 'styled';
}

// ============================================================================
// Parameter Extraction for Mixed JSX Content
// Transforms: <Text>Hello {name}</Text> → <Text>{t('Hello {name}', { name })}</Text>
// ============================================================================

// Helper: Extract parameter name from expression
function getParamName(expression, usedNames = {}) {
  let baseName = 'value';

  if (t.isIdentifier(expression)) {
    // count → "count"
    baseName = expression.name;
  } else if (t.isMemberExpression(expression)) {
    // user.name → "name", items.length → "length"
    if (t.isIdentifier(expression.property)) {
      baseName = expression.property.name;
    }
  } else if (t.isCallExpression(expression)) {
    // items.toLocaleString() → "value"
    if (
      t.isMemberExpression(expression.callee) &&
      t.isIdentifier(expression.callee.property)
    ) {
      // Try to use the object name: items.toLocaleString() → "items"
      if (t.isIdentifier(expression.callee.object)) {
        baseName = expression.callee.object.name;
      } else if (
        t.isMemberExpression(expression.callee.object) &&
        t.isIdentifier(expression.callee.object.property)
      ) {
        // stats.total.toLocaleString() → "total"
        baseName = expression.callee.object.property.name;
      }
    }
  }

  // Handle duplicates by adding numeric suffix
  if (usedNames[baseName]) {
    let counter = 1;
    while (usedNames[`${baseName}${counter}`]) {
      counter++;
    }
    baseName = `${baseName}${counter}`;
  }
  usedNames[baseName] = true;

  return baseName;
}

// Helper: Check if expression is something we can use as a parameter
function isValidParamExpression(expression) {
  // Skip literals (they should be part of the string)
  if (t.isStringLiteral(expression)) return false;
  if (t.isNumericLiteral(expression)) return false;
  if (t.isBooleanLiteral(expression)) return false;
  if (t.isNullLiteral(expression)) return false;

  // Skip conditional expressions (too complex)
  if (t.isConditionalExpression(expression)) return false;

  // Skip logical expressions (too complex)
  if (t.isLogicalExpression(expression)) return false;

  // Skip JSXEmptyExpression
  if (t.isJSXEmptyExpression(expression)) return false;

  // Allow identifiers, member expressions, call expressions
  return true;
}

// Helper: Extract parameterized content from JSX children
function extractParameterizedContent(children) {
  let template = '';
  const params = {};
  const usedNames = {};
  let hasStaticText = false;
  let hasParams = false;

  for (const child of children) {
    if (t.isJSXText(child)) {
      const text = child.value;
      if (text.trim()) {
        hasStaticText = true;
      }
      template += text;
    } else if (t.isJSXExpressionContainer(child)) {
      const expr = child.expression;

      if (t.isStringLiteral(expr)) {
        // String literal like {' '} - add to template
        template += expr.value;
        if (expr.value.trim()) {
          hasStaticText = true;
        }
      } else if (isValidParamExpression(expr)) {
        // Valid parameter expression
        const paramName = getParamName(expr, usedNames);
        template += `{${paramName}}`;
        params[paramName] = expr;
        hasParams = true;
      } else {
        // Invalid expression - can't transform
        return null;
      }
    } else {
      // Other node types (nested JSX elements, etc.) - can't transform
      return null;
    }
  }

  // Must have both static text and params to be worth transforming
  if (!hasStaticText || !hasParams) {
    return null;
  }

  // Normalize whitespace
  let normalizedTemplate = template.replace(/\s+/g, ' ').trim();

  // Skip if result is too short or empty
  if (!normalizedTemplate || normalizedTemplate.length < 2) {
    return null;
  }

  normalizedTemplate = rebrand(normalizedTemplate);

  return { template: normalizedTemplate, params };
}

// Helper: Create t() call with parameters
// t(key, fallback, params) - we pass undefined for fallback since key IS the fallback
function createTCallWithParams(template, params) {
  const properties = Object.entries(params).map(([key, valueExpr]) => {
    // Use shorthand syntax if key matches identifier name
    const isShorthand = t.isIdentifier(valueExpr) && valueExpr.name === key;

    return t.objectProperty(t.identifier(key), valueExpr, false, isShorthand);
  });

  const paramsObject = t.objectExpression(properties);

  // t(key, undefined, params) - undefined fallback uses key as fallback
  return t.callExpression(t.identifier('t'), [
    t.stringLiteral(template),
    t.identifier('undefined'),
    paramsObject,
  ]);
}

// Helper: Transform Text component with parameterized content
function transformParameterizedText(node) {
  // Skip if has nested Text components (handled separately)
  if (hasNestedTextComponents(node)) {
    return null;
  }

  // Try to extract parameterized content
  const extracted = extractParameterizedContent(node.children);
  if (!extracted) {
    return null;
  }

  const { template, params } = extracted;

  // Create {t('template', { params })} expression
  const tCall = createTCallWithParams(template, params);
  const newChild = t.jsxExpressionContainer(tCall);

  return {
    node: t.jsxElement(
      node.openingElement,
      node.closingElement,
      [newChild],
      node.selfClosing,
    ),
    original: template,
    params: Object.keys(params),
  };
}

// ============================================================================
// Mixed Static/Dynamic Content Transformation
// Handles: <Text>static {ternary} static</Text> (no nested Text elements)
// Also handles: <Text>{var} static {ternary} static</Text> (with variables)
// Also handles: Multiple ternaries and nested ternaries (up to MAX_TERNARY_BRANCHES)
// Strategy: Create complete sentences for each ternary branch combination
// ============================================================================

// Helper: Check if Text has mixed static and dynamic (ternary/conditional) content
function hasMixedStaticDynamicContent(node) {
  if (!node.children || node.children.length < 2) return false;
  if (hasNestedTextComponents(node)) return false; // Handled by transformChildrenSelectively

  // Use unified analysis
  const analysis = analyzeJSXContent(node.children);
  const strategy = getTransformStrategy(analysis);

  // Accept any multi_branched_* or branched_* strategy for t() (not i18ntext)
  return (
    strategy.strategy === 'branched_t' ||
    strategy.strategy === 'branched_parameterized_t' ||
    strategy.strategy === 'multi_branched_t' ||
    strategy.strategy === 'multi_branched_parameterized_t'
  );
}

/**
 * Generate all branch combinations for multiple/nested ternaries
 * @param {Array} ternaries - Array of ternary info from analysis
 * @returns {Array} Array of { branchSelections: Map<ternaryIndex, branchIndex>, conditions: [...] }
 */
function generateBranchCombinations(ternaries) {
  const combinations = [];

  // For each ternary, get its branches (either 2 for simple, or N for nested)
  const ternaryBranches = ternaries.map((ter, index) => {
    if (ter.isNestedTernary && ter.flattenedBranches) {
      return ter.flattenedBranches.map((branch, branchIdx) => ({
        ternaryIndex: index,
        branchIndex: branchIdx,
        value: branch.value,
        conditions: branch.conditions,
      }));
    }
    // Simple ternary: 2 branches
    return [
      {
        ternaryIndex: index,
        branchIndex: 0,
        value: ter.consequent,
        conditions: [{ test: ter.test, negated: false }],
      },
      {
        ternaryIndex: index,
        branchIndex: 1,
        value: ter.alternate,
        conditions: [{ test: ter.test, negated: true }],
      },
    ];
  });

  // Generate cartesian product of all branches
  function cartesian(arrays, current = [], depth = 0) {
    if (depth === arrays.length) {
      combinations.push([...current]);
      return;
    }
    for (const item of arrays[depth]) {
      current.push(item);
      cartesian(arrays, current, depth + 1);
      current.pop();
    }
  }

  cartesian(ternaryBranches);
  return combinations;
}

/**
 * Build combined condition for a branch combination
 * E.g., for [a=true, b=false]: a && !b
 */
function buildCombinedCondition(branchCombination) {
  const allConditions = branchCombination.flatMap((b) => b.conditions);

  if (allConditions.length === 0) return null;
  if (allConditions.length === 1) {
    const c = allConditions[0];
    return c.negated ? t.unaryExpression('!', c.test) : c.test;
  }

  // Build: cond1 && cond2 && cond3 ...
  let result = null;
  for (const c of allConditions) {
    const condExpr = c.negated ? t.unaryExpression('!', c.test) : c.test;
    result = result ? t.logicalExpression('&&', result, condExpr) : condExpr;
  }
  return result;
}

// Helper: Extract text and params from children for a specific branch combination
function extractTextWithBranchCombination(
  children,
  branchCombination,
  ternaries,
) {
  let text = '';
  const params = {};
  const usedNames = {};

  // Build a map from ternary node to selected branch value
  const ternaryValueMap = new Map();
  for (const branch of branchCombination) {
    const ternary = ternaries[branch.ternaryIndex];
    ternaryValueMap.set(ternary.node, branch.value);
  }

  for (const child of children) {
    if (t.isJSXText(child)) {
      text += child.value;
    } else if (t.isJSXExpressionContainer(child)) {
      const expr = child.expression;

      if (t.isStringLiteral(expr)) {
        text += expr.value;
      } else if (t.isIdentifier(expr)) {
        const paramName = expr.name;
        text += `{${paramName}}`;
        params[paramName] = expr;
        usedNames[paramName] = true;
      } else if (t.isMemberExpression(expr) || t.isCallExpression(expr)) {
        const paramName = getParamName(expr, usedNames);
        text += `{${paramName}}`;
        params[paramName] = expr;
      } else if (t.isConditionalExpression(expr)) {
        // Look up the selected value for this ternary
        const selectedValue = ternaryValueMap.get(child);
        if (selectedValue && t.isStringLiteral(selectedValue)) {
          text += selectedValue.value;
        }
      }
    }
  }

  let normalizedText = text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.:;!?)])/g, '$1')
    .replace(/([([])\s+/g, '$1')
    .trim();

  normalizedText = rebrand(normalizedText);

  return { text: normalizedText, params };
}

// Helper: Transform simple Text with mixed static/ternary content (with optional variables)
// Now supports multiple ternaries and nested ternaries
function transformMixedStaticDynamic(node) {
  const analysis = analyzeJSXContent(node.children);
  const strategy = getTransformStrategy(analysis);

  if (strategy.strategy === 'skip') return null;

  const { ternaries } = analysis;
  if (ternaries.length === 0) return null;

  // Generate all branch combinations
  const combinations = generateBranchCombinations(ternaries);

  // Build text and t() call for each combination
  const branchResults = combinations
    .map((combo) => {
      const extracted = extractTextWithBranchCombination(
        node.children,
        combo,
        ternaries,
      );
      const hasParams = Object.keys(extracted.params).length > 0;

      // Validate text
      if (
        !extracted.text ||
        extracted.text.length < 2 ||
        !/[a-zA-Z]/.test(extracted.text)
      ) {
        return null;
      }

      const tCall = hasParams
        ? createTCallWithParams(extracted.text, extracted.params)
        : t.callExpression(t.identifier('t'), [
            t.stringLiteral(extracted.text),
          ]);

      const condition = buildCombinedCondition(combo);

      return { text: extracted.text, tCall, condition };
    })
    .filter(Boolean);

  if (branchResults.length === 0) return null;

  // Build nested ternary expression from the outside in
  // Last branch is the final "else", work backwards
  let resultExpr = branchResults[branchResults.length - 1].tCall;

  for (let i = branchResults.length - 2; i >= 0; i--) {
    const branch = branchResults[i];
    if (branch.condition) {
      resultExpr = t.conditionalExpression(
        branch.condition,
        branch.tCall,
        resultExpr,
      );
    }
  }

  const newChild = t.jsxExpressionContainer(resultExpr);

  return t.jsxElement(
    node.openingElement,
    node.closingElement,
    [newChild],
    node.selfClosing,
  );
}

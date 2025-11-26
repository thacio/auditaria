/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * I18N TRANSFORMER TEST CASES
 *
 * This file contains all edge cases for the babel i18n transformer.
 * Each case is documented with:
 * - CASE NUMBER and NAME
 * - INPUT: The JSX pattern
 * - EXPECTED: What the transformer should produce
 * - NOTES: Any special considerations
 *
 * KEY PRINCIPLE: Complete sentences must be translated as whole units.
 * Different languages have different word orders and grammar.
 */

import type React from 'react';
import { Box, Text } from 'ink';

interface TestProps {
  count: number;
  name: string;
  isActive: boolean;
  hasFeature: boolean;
  itemCount: number;
}

export const I18nTestCases: React.FC<TestProps> = ({
  count,
  name,
  isActive,
  hasFeature,
  itemCount,
}) => {
  const icon = '✓';

  return (
    <Box flexDirection="column">
      {/* ================================================================
          CASE 1: Simple static text (WORKING)
          EXPECTED: t("Hello world")
          ================================================================ */}
      <Text>Hello world</Text>

      {/* ================================================================
          CASE 2: Nested static Text (WORKING)
          EXPECTED: I18nText with i18nKey="Click <bold>here</bold> to continue"
          ================================================================ */}
      <Text>
        Click <Text bold>here</Text> to continue
      </Text>

      {/* ================================================================
          CASE 3: Simple ternary with strings (WORKING)
          EXPECTED: isActive ? t("Status: Active") : t("Status: Inactive")
          ================================================================ */}
      <Text>
        Status: {isActive ? 'Active' : 'Inactive'}
      </Text>

      {/* ================================================================
          CASE 4: Nested Text + single ternary (WORKING)
          EXPECTED:
            count === 0
              ? I18nText("4. <bold>/help</bold> for info")
              : I18nText("3. <bold>/help</bold> for info")
          ================================================================ */}
      <Text>
        {count === 0 ? '4.' : '3.'}{' '}
        <Text bold>/help</Text>{' '}
        for more information.
      </Text>

      {/* ================================================================
          CASE 5: Variable + ternary + nested Text (BROKEN - variables lost)
          INPUT: {icon} {count} error{count > 1 ? 's' : ''} <Text>(details)</Text>
          CURRENT: I18nText("errors <accent>(details)</accent>") - WRONG! Lost icon and count
          EXPECTED:
            count > 1
              ? t("{icon} {count} errors (details)", {icon, count})
              : t("{icon} {count} error (details)", {icon, count})
            OR with I18nText if nested styling needed
          ================================================================ */}
      <Text>
        {icon} {count} error{count > 1 ? 's' : ''}{' '}
        <Text dimColor>(F12 for details)</Text>
      </Text>

      {/* ================================================================
          CASE 6: Multiple ternaries (NOT HANDLED)
          INPUT: {a ? 'A' : 'B'} middle {c ? 'C' : 'D'}
          CURRENT: Only uses first ternary, produces 2 branches
          EXPECTED: 4 branches (A+C, A+D, B+C, B+D)
            - But this creates exponential explosion!
            - Better approach: parameterize or fall back gracefully
          ================================================================ */}
      <Text>
        {isActive ? 'Active' : 'Inactive'} user with {hasFeature ? 'premium' : 'basic'} plan
      </Text>

      {/* ================================================================
          CASE 7: Ternary with non-string branches (NOT HANDLED)
          INPUT: {cond ? <Icon /> : 'text'} more
          CURRENT: Silently skips non-string, incomplete sentence
          EXPECTED: Fall back to not transforming, or handle JSX branches
          ================================================================ */}
      <Text>
        {isActive ? <Text bold>✓</Text> : '✗'} Status indicator
      </Text>

      {/* ================================================================
          CASE 8: Parameterized text without ternary (WORKING via transformParameterizedText)
          EXPECTED: t("Hello {name}!", {name})
          ================================================================ */}
      <Text>
        Hello {name}!
      </Text>

      {/* ================================================================
          CASE 9: Variable + static + nested Text (no ternary)
          INPUT: {count} items in <Text bold>cart</Text>
          CURRENT: Probably fragments or partial
          EXPECTED: t("{count} items in cart", {count}) or I18nText with param
          ================================================================ */}
      <Text>
        {count} items in <Text bold>cart</Text>
      </Text>

      {/* ================================================================
          CASE 10: Plural pattern (common i18n pattern)
          INPUT: {count} item{count !== 1 ? 's' : ''}
          EXPECTED: Ideally use ICU plural format, but at minimum:
            count !== 1 ? t("{count} items", {count}) : t("{count} item", {count})
          ================================================================ */}
      <Text>
        {itemCount} item{itemCount !== 1 ? 's' : ''} selected
      </Text>

      {/* ================================================================
          CASE 11: Nested ternary (complex)
          INPUT: {a ? (b ? 'X' : 'Y') : 'Z'}
          EXPECTED: Fall back gracefully or expand to 3 branches
          ================================================================ */}
      <Text>
        Status: {isActive ? (hasFeature ? 'Premium Active' : 'Basic Active') : 'Inactive'}
      </Text>

      {/* ================================================================
          CASE 12: Multiple nested Text elements
          EXPECTED: I18nText with multiple component slots
          ================================================================ */}
      <Text>
        Press <Text bold>Enter</Text> to confirm or <Text dimColor>Esc</Text> to cancel
      </Text>

      {/* ================================================================
          CASE 13: Ternary affects entire element visibility (&&)
          This is NOT about i18n transform, just conditional rendering
          EXPECTED: No transformation needed for the condition itself
          ================================================================ */}
      {isActive && (
        <Text>This only shows when active</Text>
      )}

      {/* ================================================================
          CASE 14: Empty ternary branch (common pattern)
          INPUT: (Use Enter{showTab ? ', Tab' : ''}, Esc)
          EXPECTED:
            showTab ? t("(Use Enter, Tab, Esc)") : t("(Use Enter, Esc)")
          This is already working via transformMixedStaticDynamic
          ================================================================ */}
      <Text>
        (Use Enter{hasFeature ? ', Tab to switch' : ''}, Esc to close)
      </Text>

      {/* ================================================================
          CASE 15: Mixed - ternary + variable + nested Text
          Most complex real-world case
          INPUT: {icon} {count} {count > 1 ? 'errors' : 'error'} in <bold>file</bold>
          EXPECTED: Complete sentence with params for each branch
          ================================================================ */}
      <Text>
        {icon} {count} {count > 1 ? 'errors' : 'error'} found in{' '}
        <Text bold>current file</Text>
      </Text>
    </Box>
  );
};

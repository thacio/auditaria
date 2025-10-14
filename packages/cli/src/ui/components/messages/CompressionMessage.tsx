/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { t , CompressionStatus } from '@thacio/auditaria-cli-core';
import type React from 'react';

import { Box, Text } from 'ink';
import type { CompressionProps } from '../../types.js';
import { CliSpinner } from '../CliSpinner.js';
import { theme } from '../../semantic-colors.js';
import { SCREEN_READER_MODEL_PREFIX } from '../../textConstants.js';

export interface CompressionDisplayProps {
  compression: CompressionProps;
}

/*
 * Compression messages appear when the /compress command is run, and show a loading spinner
 * while compression is in progress, followed up by some compression stats.
 */
export function CompressionMessage({
  compression,
}: CompressionDisplayProps): React.JSX.Element {
  const { isPending, originalTokenCount, newTokenCount, compressionStatus } =
    compression;

  const originalTokens = originalTokenCount ?? 0;
  const newTokens = newTokenCount ?? 0;

  const getCompressionText = () => {
    if (isPending) {
      return t('compression.compressing', 'Compressing chat history');
    }

    switch (compressionStatus) {
      case CompressionStatus.COMPRESSED:
        return t(
          'compression.compressed',
          'Chat history compressed from {original} to {new} tokens.',
          {
            original: originalTokens.toString(),
            new: newTokens.toString(),
          },
        );
      case CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT:
        // For smaller histories (< 50k tokens), compression overhead likely exceeds benefits
        if (originalTokens < 50000) {
          return t(
            'compression.not_beneficial',
            'Compression was not beneficial for this history size.',
          );
        }
        // For larger histories where compression should work but didn't,
        // this suggests an issue with the compression process itself
        return t(
          'compression.did_not_reduce',
          'Chat history compression did not reduce size. This may indicate issues with the compression prompt.',
        );
      case CompressionStatus.COMPRESSION_FAILED_TOKEN_COUNT_ERROR:
        return t(
          'compression.token_count_error',
          'Could not compress chat history due to a token counting error.',
        );
      case CompressionStatus.NOOP:
        return t('compression.nothing_to_compress', 'Nothing to compress.');
      default:
        return '';
    }
  };

  const text = getCompressionText();

  return (
    <Box flexDirection="row">
      <Box marginRight={1}>
        {isPending ? (
          <CliSpinner type="dots" />
        ) : (
          <Text color={theme.text.accent}>✦</Text>
        )}
      </Box>
      <Box>
        <Text
          color={
            compression.isPending ? theme.text.accent : theme.status.success
          }
          aria-label={SCREEN_READER_MODEL_PREFIX}
        >
          {text}
        </Text>
      </Box>
    </Box>
  );
}

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { render } from '../../test-utils/render.js';
import * as geminiCore from '@google/gemini-cli-core';
import { useLanguageCommand } from './useLanguageCommand.js';
import { MessageType } from '../types.js';
import type { LoadedSettings } from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';
import type { HistoryItem } from '../types.js';

describe('useLanguageCommand', () => {
  let mockLoadedSettings: LoadedSettings;
  let mockSetLanguage: ReturnType<typeof vi.fn>;
  let mockSetLanguageError: ReturnType<typeof vi.fn>;
  let mockAddItem: ReturnType<typeof vi.fn>;
  let mockRefreshStatic: ReturnType<typeof vi.fn>;
  let result: ReturnType<typeof useLanguageCommand>;

  function TestComponent() {
    result = useLanguageCommand(
      mockLoadedSettings,
      mockSetLanguageError,
      mockAddItem,
      mockRefreshStatic,
    );
    return null;
  }

  beforeEach(() => {
    vi.resetAllMocks();

    mockSetLanguage = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(geminiCore, 'setLanguage').mockImplementation(mockSetLanguage);

    mockLoadedSettings = {
      setValue: vi.fn(),
    } as unknown as LoadedSettings;
    mockSetLanguageError = vi.fn();
    mockAddItem = vi.fn<
      (item: Omit<HistoryItem, 'id'>, timestamp: number) => void
    >();
    mockRefreshStatic = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes with language dialog closed', () => {
    render(<TestComponent />);
    expect(result.isLanguageDialogOpen).toBe(false);
  });

  it('opens the language dialog', () => {
    render(<TestComponent />);

    act(() => {
      result.openLanguageDialog();
    });

    expect(result.isLanguageDialogOpen).toBe(true);
  });

  it('persists selected language in user settings and applies it', async () => {
    render(<TestComponent />);

    act(() => {
      result.openLanguageDialog();
    });

    await act(async () => {
      result.handleLanguageSelect('es');
      await Promise.resolve();
    });

    expect(mockLoadedSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'ui.language',
      'es',
    );
    expect(mockLoadedSettings.setValue).not.toHaveBeenCalledWith(
      SettingScope.System,
      'ui.language',
      'es',
    );
    expect(mockSetLanguage).toHaveBeenCalledWith('es');
    expect(mockSetLanguageError).toHaveBeenCalledWith(null);
    expect(mockAddItem).toHaveBeenCalledWith(
      {
        type: MessageType.INFO,
        text: 'Language changed to es.',
      },
      expect.any(Number),
    );
    expect(mockRefreshStatic).toHaveBeenCalledTimes(1);
    expect(result.isLanguageDialogOpen).toBe(false);
  });

  it('closes dialog without saving when selection is cancelled', async () => {
    render(<TestComponent />);

    act(() => {
      result.openLanguageDialog();
    });

    await act(async () => {
      result.handleLanguageSelect(undefined);
      await Promise.resolve();
    });

    expect(mockLoadedSettings.setValue).not.toHaveBeenCalled();
    expect(mockSetLanguage).not.toHaveBeenCalled();
    expect(result.isLanguageDialogOpen).toBe(false);
  });

  it('keeps dialog open and shows error when applying language fails', async () => {
    mockSetLanguage.mockRejectedValueOnce(new Error('boom'));
    render(<TestComponent />);

    act(() => {
      result.openLanguageDialog();
    });

    await act(async () => {
      result.handleLanguageSelect('pt');
      await Promise.resolve();
    });

    expect(mockLoadedSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'ui.language',
      'pt',
    );
    expect(mockSetLanguageError).toHaveBeenCalledWith(
      'Failed to apply language "pt". Please try again.',
    );
    expect(mockRefreshStatic).not.toHaveBeenCalled();
    expect(result.isLanguageDialogOpen).toBe(true);
  });
});

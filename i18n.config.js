/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * i18n Transformation Configuration
 *
 * This config controls build-time i18n transformation.
 * Environment variables override these settings if present.
 *
 * Usage:
 *   npm run bundle                    # Uses config defaults
 *   I18N_TRANSFORM=true npm run bundle # Override via env var
 */

export default {
  // Enable i18n transformation during build
  // Override: I18N_TRANSFORM=true
  enabled: true,

  // Generate transformation report (i18n-transform-report.json/txt)
  // Override: I18N_REPORT=true
  report: true,

  // Enable debug logging
  // Override: I18N_DEBUG=true
  debug: false,
};

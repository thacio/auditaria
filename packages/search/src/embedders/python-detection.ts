/**
 * Python Detection Utility
 * Detects Python availability and validates version for the Python embedder.
 */

import { spawn } from 'node:child_process';
import { platform } from 'node:os';

// ============================================================================
// Types
// ============================================================================

export interface PythonDetectionResult {
  /** Whether Python is available */
  available: boolean;
  /** The Python command to use (python3 or python) */
  command: string | null;
  /** Python version string (e.g., "3.11.0") */
  version: string | null;
  /** Error message if Python is not available */
  error: string | null;
}

// ============================================================================
// Constants
// ============================================================================

/** Minimum required Python version */
const MIN_PYTHON_VERSION = [3, 8, 0];

/** Cache for detection result */
let cachedResult: PythonDetectionResult | null = null;

// ============================================================================
// Detection Functions
// ============================================================================

/**
 * Execute a command and return stdout.
 */
async function execCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: platform() === 'win32',
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr || `Process exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Parse Python version string (e.g., "Python 3.11.0" -> [3, 11, 0])
 */
function parseVersion(versionStr: string): number[] | null {
  const match = versionStr.match(/Python\s+(\d+)\.(\d+)\.(\d+)/i);
  if (!match) {
    return null;
  }
  return [
    parseInt(match[1], 10),
    parseInt(match[2], 10),
    parseInt(match[3], 10),
  ];
}

/**
 * Compare version arrays.
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 */
function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

/**
 * Try to detect Python with a specific command.
 */
async function tryPythonCommand(command: string): Promise<{
  success: boolean;
  version: string | null;
  error: string | null;
}> {
  try {
    const output = await execCommand(command, ['--version']);
    const version = parseVersion(output);

    if (!version) {
      return {
        success: false,
        version: null,
        error: `Could not parse version from: ${output}`,
      };
    }

    // Check minimum version
    if (compareVersions(version, MIN_PYTHON_VERSION) < 0) {
      return {
        success: false,
        version: version.join('.'),
        error: `Python ${version.join('.')} is below minimum required version ${MIN_PYTHON_VERSION.join('.')}`,
      };
    }

    return {
      success: true,
      version: version.join('.'),
      error: null,
    };
  } catch (err) {
    return {
      success: false,
      version: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Detect Python availability.
 * Tries python3 first (Unix standard), then python (Windows, some Linux).
 * Caches the result for subsequent calls.
 */
export async function detectPython(
  forceRefresh = false,
): Promise<PythonDetectionResult> {
  if (cachedResult && !forceRefresh) {
    return cachedResult;
  }

  // Commands to try in order of preference
  const commands =
    platform() === 'win32'
      ? ['python', 'python3', 'py -3']
      : ['python3', 'python'];

  for (const command of commands) {
    const result = await tryPythonCommand(command);
    if (result.success) {
      cachedResult = {
        available: true,
        command,
        version: result.version,
        error: null,
      };
      return cachedResult;
    }
  }

  // No Python found
  cachedResult = {
    available: false,
    command: null,
    version: null,
    error: 'Python 3.8+ not found. Tried: ' + commands.join(', '),
  };

  return cachedResult;
}

/**
 * Check if Python is available (quick check using cache).
 */
export async function isPythonAvailable(): Promise<boolean> {
  const result = await detectPython();
  return result.available;
}

/**
 * Get the Python command to use.
 * Returns null if Python is not available.
 */
export async function getPythonCommand(): Promise<string | null> {
  const result = await detectPython();
  return result.command;
}

/**
 * Clear the cached detection result.
 * Useful for testing or after installing Python.
 */
export function clearPythonDetectionCache(): void {
  cachedResult = null;
}

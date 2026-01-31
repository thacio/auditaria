/**
 * Type declarations for vectorlite
 * @see https://github.com/1yefuwang1/vectorlite
 */
declare module 'vectorlite' {
  /**
   * Returns the path to the vectorlite SQLite extension.
   * Use this with better-sqlite3's loadExtension() method.
   *
   * @returns The file path to the vectorlite extension
   */
  export function vectorlitePath(): string;
}

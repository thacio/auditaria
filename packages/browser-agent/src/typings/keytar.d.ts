// Type declarations for keytar - native module that may not be available in CI
// The actual import is dynamic (await import('keytar')) so this only provides types
declare module 'keytar' {
  export function getPassword(
    service: string,
    account: string,
  ): Promise<string | null>;
  export function setPassword(
    service: string,
    account: string,
    password: string,
  ): Promise<void>;
  export function deletePassword(
    service: string,
    account: string,
  ): Promise<boolean>;
  export function findPassword(service: string): Promise<string | null>;
  export function findCredentials(
    service: string,
  ): Promise<Array<{ account: string; password: string }>>;
}

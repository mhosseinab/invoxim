import type { TenantContext } from "@invoxim/core";
export type SecretPurpose =
  | "mailbox-credentials"
  | "storage-credentials"
  | "byok-key"
  | "oauth-pkce";
export interface ProviderCredentials {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}
export interface SecretPayloads {
  "mailbox-credentials": ProviderCredentials;
  "storage-credentials": ProviderCredentials;
  "byok-key": { key: string };
  "oauth-pkce": { verifier: string };
}
export interface CipherBinding<P extends SecretPurpose = SecretPurpose> {
  entityId: string;
  purpose: P;
}
export interface Keyring {
  activeVersion: number;
  keys: Readonly<Record<number, string>>;
}
export interface CredentialCipher {
  seal<P extends SecretPurpose>(
    context: TenantContext,
    binding: CipherBinding<P>,
    payload: SecretPayloads[P],
  ): Promise<string>;
  open<P extends SecretPurpose>(
    context: TenantContext,
    binding: CipherBinding<P>,
    envelope: string,
  ): Promise<SecretPayloads[P]>;
  readonly activeVersion: number;
}
export type CredentialTarget =
  | { kind: "connection"; id: string; generation: number }
  | { kind: "byok"; id: "primary"; generation: number };
export interface CredentialSnapshot {
  version: number;
  keyVersion: number;
  generation: number;
  secret: ProviderCredentials | { key: string };
}
export interface CredentialMetadata {
  configured: boolean;
  version: number;
  keyVersion: number | null;
  generation: number;
}
export type OAuthPurpose = "mailbox" | "storage";
export type OAuthProvider = "google" | "microsoft";
export type OAuthCallbacks = Readonly<
  Partial<
    Record<OAuthPurpose, Readonly<Partial<Record<OAuthProvider, string>>>>
  >
>;
export interface OAuthBinding {
  sessionId: string;
  purpose: OAuthPurpose;
  provider: OAuthProvider;
}

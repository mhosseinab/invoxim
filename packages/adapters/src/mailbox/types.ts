import type { CredentialCipher } from "../security/types";

export interface MailboxServiceConfiguration {
  provider: "gmail" | "outlook";
  oauthProvider: "google" | "microsoft";
  callback: string;
  limit: number;
  cipher: CredentialCipher;
  scopes: readonly string[];
}

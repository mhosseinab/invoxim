import type { CredentialCipher } from "../security/types";
/** Server-composed configuration; account and storage consent remain separate from login/mail. */
export interface DriveServiceConfiguration {
  provider: "google-drive";
  oauthProvider: "google";
  callback: string;
  cipher: CredentialCipher;
  scopes: readonly string[];
}

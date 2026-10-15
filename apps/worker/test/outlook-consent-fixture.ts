/**
 * Synthetic reviewed processing consent for Outlook runner suites. Mirrors the
 * shape onboarding start creates: an active AI selection plus a consent whose
 * revision, destination, disclosure version and configuration digest match it.
 */
export const reviewedConsentDigest = "5".repeat(64);
export async function seedReviewedConsent(
  db: D1Database,
  input: { userId: string; consentId: string; connectionId: string },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO ai_settings(user_id,mode,provider_id,model_id,config_version,revision,consent_version,status) VALUES(?,'hosted','synthetic','synthetic-model','synthetic-v1',1,1,'active') ON CONFLICT(user_id) DO NOTHING",
    )
    .bind(input.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized,accepted_configuration_digest) VALUES(?,?,?,1,'synthetic','local',1,0,1,?)",
    )
    .bind(
      input.consentId,
      input.userId,
      input.connectionId,
      reviewedConsentDigest,
    )
    .run();
}

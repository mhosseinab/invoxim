/** Internal SQL aliases only; never pass request/provider text. */
export function sourceNotDiscardedSql(
  sourceAlias: "s" | "sm" | "source_messages",
) {
  return `NOT EXISTS(SELECT 1 FROM correction_audit discarded JOIN review_items discarded_review ON discarded_review.user_id=discarded.user_id AND discarded_review.id=discarded.entity_id JOIN documents discarded_document ON discarded_document.user_id=discarded_review.user_id AND discarded_document.id=discarded_review.document_id WHERE discarded.user_id=${sourceAlias}.user_id AND discarded.entity_kind='review' AND discarded.action='not-a-purchase' AND discarded_document.source_message_id=${sourceAlias}.id)`;
}

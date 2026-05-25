UPDATE "PaymentMatch" AS pm
SET
  "matchStatus" = 'NEEDS_REVIEW',
  "confidence" = GREATEST(pm."confidence", 20),
  "reason" = '["Inbound transaction has no valid paymentCode and requires manual confirmation."]'::JSONB
FROM "BankTransaction" AS bt
WHERE
  pm."transactionId" = bt."id"
  AND pm."matchStatus" = 'IGNORED'
  AND bt."type" = 'IN'
  AND bt."amount" > 0
  AND COALESCE(bt."description", '') !~* 'RTP-[A-Z0-9]{6}';

UPDATE "BankTransaction" AS bt
SET "classification" = 'SUSPICIOUS'
WHERE
  bt."classification" = 'OTHER'
  AND bt."type" = 'IN'
  AND bt."amount" > 0
  AND COALESCE(bt."description", '') !~* 'RTP-[A-Z0-9]{6}'
  AND EXISTS (
    SELECT 1
    FROM "PaymentMatch" AS pm
    WHERE pm."transactionId" = bt."id" AND pm."matchStatus" = 'NEEDS_REVIEW'
  );

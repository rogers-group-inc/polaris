-- Screenshots pasted into the AI assistant (business rule 95(l)). One row per
-- image on a user turn; deleted with its message, so conversation retention,
-- /clear and delete need nothing extra. mimeType is sniffed from the bytes.
CREATE TABLE "assistant_message_images" (
    "id"        TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "mimeType"  TEXT NOT NULL,
    "bytes"     BYTEA NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "position"  INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_message_images_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "assistant_message_images_messageId_idx" ON "assistant_message_images"("messageId");

ALTER TABLE "assistant_message_images"
    ADD CONSTRAINT "assistant_message_images_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "assistant_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

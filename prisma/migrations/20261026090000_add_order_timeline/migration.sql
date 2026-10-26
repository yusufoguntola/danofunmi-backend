-- CreateTable
CREATE TABLE "OrderTimeline" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "opensOn" DATE NOT NULL,
    "closesOn" DATE NOT NULL,
    "deliveryStartsOn" DATE NOT NULL,
    "deliveryEndsOn" DATE NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderTimeline_pkey" PRIMARY KEY ("id")
);

-- Seed with the November 2026 run already advertised on the site's flyer, so
-- there's always a timeline to read from — admin edits it from here on.
INSERT INTO "OrderTimeline" ("id", "opensOn", "closesOn", "deliveryStartsOn", "deliveryEndsOn", "updatedAt")
VALUES ('singleton', '2026-10-25', '2026-11-13', '2026-11-16', '2026-11-18', CURRENT_TIMESTAMP);

-- Workshop Service Scheduler — database schema
-- Table and column names are PascalCase per the ERD (docs/images/DatabaseSchema.png).

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE "Dealership" (
    "Id"        UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    "IsActive"  BOOLEAN     NOT NULL DEFAULT true,
    "CreatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "UpdatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "Vehicle" (
    "Id"         UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    "CustomerId" TEXT        NOT NULL,
    "VIN"        TEXT        NOT NULL,
    "Model"      TEXT        NOT NULL,
    "CreatedAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
    "UpdatedAt"  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "ServiceBay" (
    "Id"           UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    "DealershipId" UUID        NOT NULL REFERENCES "Dealership" ("Id"),
    "IsActive"     BOOLEAN     NOT NULL DEFAULT true,
    "CreatedAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
    "UpdatedAt"    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "Technician" (
    "Id"           UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    "DealershipId" UUID        NOT NULL REFERENCES "Dealership" ("Id"),
    "TechLevel"    INTEGER     NOT NULL,
    "IsActive"     BOOLEAN     NOT NULL DEFAULT true,
    "CreatedAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
    "UpdatedAt"    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "WorkshopService" (
    "Id"                UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    "DisplayName"       TEXT        NOT NULL,
    "Duration"          INTEGER     NOT NULL, -- minutes
    "RequiredTechLevel" INTEGER     NOT NULL,
    "IsActive"          BOOLEAN     NOT NULL DEFAULT true,
    "CreatedAt"         TIMESTAMPTZ NOT NULL DEFAULT now(),
    "UpdatedAt"         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "WorkshopServiceSchedule" (
    "Id"                UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    "WorkshopServiceId" UUID        NOT NULL REFERENCES "WorkshopService" ("Id"),
    "DealershipId"      UUID        NOT NULL REFERENCES "Dealership" ("Id"),
    "ServiceBayId"      UUID        NOT NULL REFERENCES "ServiceBay" ("Id"),
    "TechnicianId"      UUID        NOT NULL REFERENCES "Technician" ("Id"),
    "VehicleId"         UUID        NOT NULL REFERENCES "Vehicle" ("Id"),
    "StartTime"         TIMESTAMPTZ NOT NULL,
    "EndTime"           TIMESTAMPTZ NOT NULL,
    "RequestedUserId"   TEXT        NOT NULL,
    "Status"            TEXT        NOT NULL,
    "CreatedAt"         TIMESTAMPTZ NOT NULL DEFAULT now(),
    "UpdatedAt"         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Required for availability-check subqueries (see Scheduler Service DD, 3.3)
CREATE INDEX ON "WorkshopServiceSchedule" ("ServiceBayId", "StartTime", "EndTime");
CREATE INDEX ON "WorkshopServiceSchedule" ("TechnicianId", "StartTime", "EndTime");

-- DB-level guardrail against overlapping appointments (see Scheduler Service DD, 3.4)
-- tstzrange default bounds are [) — lower-inclusive, upper-exclusive — matching the
-- half-open interval semantics used in the application-level overlap check.
ALTER TABLE "WorkshopServiceSchedule"
    ADD CONSTRAINT "NoOverlapPerBay"
    EXCLUDE USING gist ("ServiceBayId" WITH =, tstzrange("StartTime", "EndTime") WITH &&);

ALTER TABLE "WorkshopServiceSchedule"
    ADD CONSTRAINT "NoOverlapPerTechnician"
    EXCLUDE USING gist ("TechnicianId" WITH =, tstzrange("StartTime", "EndTime") WITH &&);

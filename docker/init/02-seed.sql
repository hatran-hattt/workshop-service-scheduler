-- Workshop Service Scheduler — fixture seed data
-- Fixed UUIDs let integration tests reference entities by known values.
-- UUID leading digit: 1=Dealership  2=ServiceBay  3=Technician
--                     4=WorkshopService  5=Vehicle

-- Dealerships
INSERT INTO "Dealership" ("Id", "IsActive") VALUES
    ('10000000-0000-0000-0000-000000000001', true),
    ('10000000-0000-0000-0000-000000000002', true);

-- Service bays — 2 per dealership
INSERT INTO "ServiceBay" ("Id", "DealershipId", "IsActive") VALUES
    ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', true),
    ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', true),
    ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', true),
    ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000002', true);

-- Technicians — 3 per dealership at TechLevel 1, 2, 3
INSERT INTO "Technician" ("Id", "DealershipId", "TechLevel", "IsActive") VALUES
    ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 1, true),
    ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 2, true),
    ('30000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 3, true),
    ('30000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000002', 1, true),
    ('30000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000002', 2, true),
    ('30000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000002', 3, true);

-- Workshop services — one low-skill short job, one high-skill long job
INSERT INTO "WorkshopService" ("Id", "DisplayName", "Duration", "RequiredTechLevel", "IsActive") VALUES
    ('40000000-0000-0000-0000-000000000001', 'Oil Change',      45,  1, true),
    ('40000000-0000-0000-0000-000000000002', 'Engine Overhaul', 120, 3, true);

-- Vehicles — user-001 owns two, user-002 owns one
INSERT INTO "Vehicle" ("Id", "CustomerId", "VIN", "Model") VALUES
    ('50000000-0000-0000-0000-000000000001', 'user-001', 'WBA1A2C50DV000001', 'BMW 3 Series'),
    ('50000000-0000-0000-0000-000000000002', 'user-001', 'WBA1A2C50DV000002', 'BMW 5 Series'),
    ('50000000-0000-0000-0000-000000000003', 'user-002', 'WBA1A2C50DV000003', 'BMW X5');

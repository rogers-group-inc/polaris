-- Business rule 179: a Room view's hand-routed cables between racked devices.
ALTER TABLE "topology_views" ADD COLUMN "cable_routes" JSONB NOT NULL DEFAULT '{}';

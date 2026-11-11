-- Room views (business rule 156): Rack and Wall views become one Room mode.
--
-- A Room view stands for one room (r:) and holds the room's racks and its
-- junction boxes side by side; a wall is just a big junction box, and a rack
-- never sits in a junction box. This converts every stored Rack and Wall view:
--
--   * every Rack and Wall view standing for the SAME room (same site, same
--     area / building / floor / room, case- and spacing-blind) folds into ONE
--     Room view: the oldest view's row, its name kept. Its racks come first
--     (every view's racks, then each wall's Rack item as a rack of that size),
--     then its junction boxes (every wall). Every placement is kept;
--   * a view with no room converts on its own;
--   * a Rack view standing for one rack with exactly one rack, or a Wall view
--     standing for one junction box with exactly one wall, gives that rack or
--     box the region's name, so a device in it keeps writing the same code;
--   * the region drops its rack and junction box (they are now the view's
--     own racks and boxes) and becomes null when no room chain is left;
--   * a device can be in one place: racked wins; a second placement of the
--     same device is dropped and named in the conversion's Event.
--
-- Nothing is lost but the duplicate placements the Event lists. Descriptions
-- are not touched. The folded-away views' rows and their saved layouts go;
-- the views never held an uploaded image (only Topology views do).

DO $$
DECLARE
  grp           RECORD;
  v             RECORD;
  item          JSONB;
  keeper_id     TEXT;
  keeper_name   TEXT;
  keeper_region JSONB;
  view_racks    JSONB;
  view_walls    JSONB;
  acc_racks     JSONB;
  acc_walls     JSONB;
  rp            JSONB;
  wp            JSONB;
  seen          TEXT[];
  dropped       JSONB;
  merged        JSONB;
  folded        TEXT[];
  room_region   JSONB;
  n_views       INT;
BEGIN
  FOR grp IN
    SELECT site_id,
           CASE WHEN region IS NOT NULL AND NULLIF(btrim(region->>'room'), '') IS NOT NULL
             THEN lower(regexp_replace(btrim(coalesce(region->>'area', '')), '\s+', ' ', 'g')) || '|' ||
                  lower(regexp_replace(btrim(coalesce(region->>'building', '')), '\s+', ' ', 'g')) || '|' ||
                  lower(regexp_replace(btrim(coalesce(region->>'floor', '')), '\s+', ' ', 'g')) || '|' ||
                  lower(regexp_replace(btrim(coalesce(region->>'room', '')), '\s+', ' ', 'g'))
             ELSE 'view:' || id
           END AS room_key
      FROM topology_views
     WHERE mode IN ('rack', 'wall')
     GROUP BY 1, 2
  LOOP
    keeper_id := NULL;
    acc_racks := '[]'::jsonb; acc_walls := '[]'::jsonb; rp := '[]'::jsonb; wp := '[]'::jsonb;
    seen := ARRAY[]::TEXT[]; dropped := '[]'::jsonb; merged := '[]'::jsonb; folded := ARRAY[]::TEXT[];
    n_views := 0;

    -- Pass 1: racks and racked items, oldest view first.
    FOR v IN
      SELECT * FROM topology_views
       WHERE site_id = grp.site_id AND mode IN ('rack', 'wall')
         AND (CASE WHEN region IS NOT NULL AND NULLIF(btrim(region->>'room'), '') IS NOT NULL
               THEN lower(regexp_replace(btrim(coalesce(region->>'area', '')), '\s+', ' ', 'g')) || '|' ||
                    lower(regexp_replace(btrim(coalesce(region->>'building', '')), '\s+', ' ', 'g')) || '|' ||
                    lower(regexp_replace(btrim(coalesce(region->>'floor', '')), '\s+', ' ', 'g')) || '|' ||
                    lower(regexp_replace(btrim(coalesce(region->>'room', '')), '\s+', ' ', 'g'))
               ELSE 'view:' || id END) = grp.room_key
       ORDER BY created_at, id
    LOOP
      n_views := n_views + 1;
      IF keeper_id IS NULL THEN
        keeper_id := v.id; keeper_name := v.name; keeper_region := v.region;
      ELSE
        folded := folded || v.id;
      END IF;
      merged := merged || jsonb_build_object('id', v.id, 'name', v.name, 'mode', v.mode);

      view_racks := CASE WHEN jsonb_typeof(v.racks) = 'array' THEN v.racks ELSE '[]'::jsonb END;
      -- A Rack view for one rack, holding one rack: that rack takes the rack's name.
      IF v.mode = 'rack' AND jsonb_array_length(view_racks) = 1 AND NULLIF(btrim(v.region->>'rack'), '') IS NOT NULL THEN
        view_racks := jsonb_build_array(jsonb_set(view_racks->0, '{name}', to_jsonb(left(btrim(v.region->>'rack'), 60))));
      END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(view_racks) LOOP
        acc_racks := acc_racks || jsonb_build_array(jsonb_set(item, '{order}', to_jsonb(jsonb_array_length(acc_racks))));
      END LOOP;
      -- A wall's Rack item becomes a rack of the same size in the room.
      IF jsonb_typeof(v.wall_placements) = 'array' THEN
        FOR item IN SELECT value FROM jsonb_array_elements(v.wall_placements) WHERE value->>'kind' = 'rack' LOOP
          acc_racks := acc_racks || jsonb_build_array(jsonb_build_object(
            'id', gen_random_uuid()::text,
            'name', left(coalesce(NULLIF(btrim(item->>'label'), ''), 'Rack'), 60),
            'units', greatest(1, least(60, coalesce((item->>'units')::int, 42))),
            'order', jsonb_array_length(acc_racks),
            'face', 'front'));
        END LOOP;
      END IF;
      IF jsonb_typeof(v.rack_placements) = 'array' THEN
        FOR item IN SELECT value FROM jsonb_array_elements(v.rack_placements) LOOP
          IF item->>'assetId' IS NOT NULL AND (item->>'assetId') = ANY(seen) THEN
            dropped := dropped || jsonb_build_object('assetId', item->>'assetId', 'from', v.name);
          ELSE
            rp := rp || jsonb_build_array(item);
            IF item->>'assetId' IS NOT NULL THEN seen := seen || (item->>'assetId'); END IF;
          END IF;
        END LOOP;
      END IF;
    END LOOP;

    -- Pass 2: junction boxes (the walls) and what is in them, same order.
    FOR v IN
      SELECT * FROM topology_views
       WHERE id = keeper_id OR id = ANY(folded)
       ORDER BY created_at, id
    LOOP
      view_walls := CASE WHEN jsonb_typeof(v.walls) = 'array' THEN v.walls ELSE '[]'::jsonb END;
      -- A Wall view for one junction box, holding one wall: that box takes the box's name.
      IF v.mode = 'wall' AND jsonb_array_length(view_walls) = 1 AND NULLIF(btrim(v.region->>'junctionBox'), '') IS NOT NULL THEN
        view_walls := jsonb_build_array(jsonb_set(view_walls->0, '{name}', to_jsonb(left(btrim(v.region->>'junctionBox'), 60))));
      END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(view_walls) LOOP
        acc_walls := acc_walls || jsonb_build_array(jsonb_set(item, '{order}', to_jsonb(jsonb_array_length(acc_walls))));
      END LOOP;
      IF jsonb_typeof(v.wall_placements) = 'array' THEN
        FOR item IN SELECT value FROM jsonb_array_elements(v.wall_placements) WHERE coalesce(value->>'kind', '') <> 'rack' LOOP
          IF item->>'assetId' IS NOT NULL AND (item->>'assetId') = ANY(seen) THEN
            dropped := dropped || jsonb_build_object('assetId', item->>'assetId', 'from', v.name);
          ELSE
            wp := wp || jsonb_build_array(item - 'units' - 'linkedViewId' || jsonb_build_object('units', NULL, 'linkedViewId', NULL));
            IF item->>'assetId' IS NOT NULL THEN seen := seen || (item->>'assetId'); END IF;
          END IF;
        END LOOP;
      END IF;
    END LOOP;

    -- The keeper's region: its room chain only, or null.
    room_region := NULL;
    IF keeper_region IS NOT NULL AND jsonb_typeof(keeper_region) = 'object' THEN
      room_region := (keeper_region - 'rack' - 'junctionBox') || jsonb_build_object('rack', NULL, 'junctionBox', NULL);
      IF coalesce(NULLIF(btrim(room_region->>'area'), ''), NULLIF(btrim(room_region->>'building'), ''),
                  NULLIF(btrim(room_region->>'floor'), ''), NULLIF(btrim(room_region->>'room'), '')) IS NULL THEN
        room_region := NULL;
      END IF;
    END IF;

    UPDATE topology_views
       SET mode = 'room', region = room_region, racks = acc_racks, rack_placements = rp,
           walls = acc_walls, wall_placements = wp, updated_at = now()
     WHERE id = keeper_id;

    IF array_length(folded, 1) IS NOT NULL THEN
      DELETE FROM topology_layouts t
       USING unnest(folded) AS f(id)
       WHERE t.site_id = grp.site_id AND t.view LIKE 'v:' || f.id || '|%';
      DELETE FROM topology_views WHERE id = ANY(folded);
    END IF;

    INSERT INTO "events" ("id", "timestamp", "level", "levelRank", "action", "resourceType", "resourceId", "resourceName", "actor", "message", "details", "assetId")
    VALUES (
      gen_random_uuid()::text,
      (now() AT TIME ZONE 'UTC'),
      CASE WHEN jsonb_array_length(dropped) > 0 THEN 'warning' ELSE 'info' END,
      CASE WHEN jsonb_array_length(dropped) > 0 THEN 1 ELSE 0 END,
      'map.topology.views_converted',
      'asset',
      grp.site_id,
      NULL,
      'system:migration',
      CASE WHEN n_views > 1
        THEN n_views || ' Rack / Wall views of one room became the Room view "' || keeper_name || '"'
        ELSE 'The ' || (merged->0->>'mode') || ' view "' || keeper_name || '" became a Room view' END ||
      CASE WHEN jsonb_array_length(dropped) > 0
        THEN '; ' || jsonb_array_length(dropped) || ' duplicate placement(s) of a device already placed were dropped' ELSE '' END,
      jsonb_build_object('viewId', keeper_id, 'name', keeper_name, 'converted', merged, 'droppedPlacements', dropped),
      grp.site_id
    );
  END LOOP;
END $$;

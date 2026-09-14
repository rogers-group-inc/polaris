-- Geocode cache: re-key from (query) to (provider, query).
--
-- The geocoder now walks a provider chain (nominatim -> census by default)
-- instead of calling Nominatim alone, so the cache has to hold one row per
-- provider per string. Keying on `query` alone would let a Nominatim negative
-- ("OSM has never heard of this street") shadow the Census leg for 90 days,
-- which is exactly the case the chain exists to catch.
--
-- Existing rows already carry provider = 'nominatim', so they survive the
-- re-key unchanged and keep suppressing repeat Nominatim calls for input that
-- provider will never resolve. No backfill, no invalidation: the census leg
-- simply has no rows yet and starts cold.
--
-- Safety: the composite index is created first. If any duplicate (provider,
-- query) pairs somehow exist the CREATE fails and the transaction rolls back
-- with the old unique still in place, rather than dropping the old constraint
-- and leaving the table unprotected.

CREATE UNIQUE INDEX "geocode_cache_provider_query_key" ON "geocode_cache"("provider", "query");

DROP INDEX "geocode_cache_query_key";

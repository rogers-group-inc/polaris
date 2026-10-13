-- Business rule 115: operator and seeded regexes run on RE2, which has no
-- lookaround. The shipped FortiSwitch model-parse rule (stamped into the
-- Fortinet profile's FortiSwitch `model` override by the seed job) used a
-- `(?!v\d)` lookahead, so without this every existing install's FortiSwitch
-- model parse would be skipped as uncompilable.
--
-- Only rows still carrying the EXACT old seed text are rewritten — an
-- operator-edited pattern is the operator's, and is reported as unusable (and
-- skipped) until they rewrite it. The replacement is the same rule without the
-- lookahead: a token that starts with anything but `v`, or is exactly `v`, or
-- is `v` followed by a non-digit (see utils/fortiswitchModel.ts).
UPDATE "manufacturer_profile_metric_overrides"
   SET "parsePattern" = '^([^v\n].*?|v|v[^\d\n].*?)[-\s]v\d'
 WHERE "parsePattern" = '^(?!v\d)(.+?)[-\s]v\d';

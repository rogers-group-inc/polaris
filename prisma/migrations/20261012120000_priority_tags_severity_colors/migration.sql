-- The default Priority tags (20261011200000_priority_severity_tags) now paint
-- with their severity's THEME TOKEN instead of a fixed hex: a Tag color may be
-- a severity reference ("severity:warning"), which the browser resolves to the
-- same token the severity pills and chart bands use (tagColorCss in
-- public/js/app.js). The seeded mid-tone hexes only approximated those colors,
-- and Warning (#f59e0b) and Serious (#ff8a00) read as two shades of one orange
-- where the bands draw a yellow and an orange.
--
-- Only a tag still on its seeded name, category AND color is converted, so a
-- default the operator recolored, renamed or moved keeps what they chose.

UPDATE "tags" SET "color" = 'severity:notice'
  WHERE "name" = 'Notice'        AND "category" = 'Priority' AND lower("color") = '#64748b';
UPDATE "tags" SET "color" = 'severity:informational'
  WHERE "name" = 'Informational' AND "category" = 'Priority' AND lower("color") = '#0288d1';
UPDATE "tags" SET "color" = 'severity:warning'
  WHERE "name" = 'Warning'       AND "category" = 'Priority' AND lower("color") = '#f59e0b';
UPDATE "tags" SET "color" = 'severity:serious'
  WHERE "name" = 'Serious'       AND "category" = 'Priority' AND lower("color") = '#ff8a00';
UPDATE "tags" SET "color" = 'severity:critical'
  WHERE "name" = 'Critical'      AND "category" = 'Priority' AND lower("color") = '#ef4444';

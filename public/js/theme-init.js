// Runs before CSS loads to apply the user's saved theme and avoid a flash of
// wrong theme on pages like login and setup. Kept as a standalone file so we
// can drop 'unsafe-inline' from the script CSP.
//
// With nothing saved — a fresh browser, and always the case on the login page
// of a first visit — follow the OS: "morning" for a light preference, and
// "nightfall" for dark or for a browser that expresses no preference. Nothing
// is written to localStorage here: an unsaved preference is what keeps a user
// tracking their system, and the in-app theme picker is what opts them out.
// A retired theme id (the old "dark"/"light") fails the KNOWN check and falls
// back the same way as no preference at all.
(function () {
  // The selectable themes only. "afternoon" is deliberately absent: it is a
  // transit palette the dial fades through, never a saved preference, so a
  // reload mid-turn lands on a real theme instead of a waypoint.
  var KNOWN = ["morning", "noon", "nightfall"];
  var saved = null;
  try { saved = localStorage.getItem("polaris-theme"); } catch (e) {}
  if (saved && KNOWN.indexOf(saved) === -1) saved = null;
  if (!saved) {
    var light = false;
    try { light = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches; } catch (e) {}
    saved = light ? "morning" : "nightfall";
  }
  document.documentElement.setAttribute("data-theme", saved);
})();

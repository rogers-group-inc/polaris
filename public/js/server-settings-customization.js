/**
 * public/js/server-settings-customization.js — Server Settings →
 * Customization: branding (app name, subtitle, logo) and the reboot settings.
 *
 * Split out of server-settings.js (CQ-F051) as a byte-for-byte move. A plain
 * browser script: its functions and `var`s are page globals, called from the
 * core's tab dispatch (`loadCustomizationTab`). Loads AFTER server-settings.js
 * — tests/unit/serverSettingsSplit.test.ts holds the order.
 */

// ─── Customization Tab ─────────────────────────────────────────────────────

var _brandingLoaded = false;
// Shipped-default logo URLs, current first. "/logo.png" was retired 2026-08 but
// is still stored by installs seeded before then; only the pre-upgrade fallback
// below consults this. Mirrors DEFAULT_LOGO_URLS in services/brandingService.ts.
var DEFAULT_LOGO_URLS = ["/img/brand/polaris-symbol-dark.png", "/logo.png"];
var _brandingData = { appName: "Polaris", subtitle: "Network Management Tool", logoUrl: "/img/brand/polaris-symbol-dark.png" };

var _rebootSettingsData = null;

async function loadCustomizationTab() {
  var container = document.getElementById("tab-customization");
  container.innerHTML = '<div class="settings-card"><p class="empty-state">Loading...</p></div>';

  try {
    // The Reboots card's setting rides along; a failed read renders the card
    // as an error rather than failing the whole tab.
    var both = await Promise.all([
      api.serverSettings.getBranding(),
      api.serverSettings.rebootGet().then(function (r) { return r.reboot; }, function () { return null; }),
    ]);
    _brandingData = both[0];
    _rebootSettingsData = both[1];
    _brandingLoaded = true;
    renderCustomizationTab();
  } catch (err) {
    container.innerHTML = '<div class="settings-card"><p class="empty-state">Error: ' + escapeHtml(err.message) + '</p></div>';
  }
}

function renderCustomizationTab() {
  var container = document.getElementById("tab-customization");
  // `customLogo` is computed server-side (brandingService.hasCustomLogo); the
  // path comparison is the fallback for a pre-upgrade payload.
  var isCustomLogo = _brandingData.customLogo !== undefined
    ? _brandingData.customLogo
    : Boolean(_brandingData.logoUrl && DEFAULT_LOGO_URLS.indexOf(_brandingData.logoUrl) === -1);
  // Placement + accent default ON/OFF the same way the server does, so an
  // install that has never saved this card renders its real behavior.
  var logoAccent    = _brandingData.logoAccent === true;
  var logoOnLogin   = _brandingData.logoOnLogin !== false;
  var logoOnSidebar = _brandingData.logoOnSidebar !== false;
  // The preview must show what the surfaces show — i.e. the composited PNG
  // once the accent is on. Cache-busted per render since the upload route
  // reuses one filename.
  var previewSrc = isCustomLogo
    ? (logoAccent
        // Same theme the surfaces will request, so the preview shows the
        // variant this operator is actually looking at.
        ? "/api/v1/server-settings/branding/logo-accent.png?theme=" +
          PolarisBrandLogo.currentTheme() + "&t=" + Date.now()
        : _brandingData.logoUrl)
    : PolarisBrandLogo.ASSETS.sidebar[PolarisBrandLogo.currentTheme()];
  // Pre-feature payloads carry no temperatureUnit — treat anything but "f" as °C,
  // matching normalizeTemperatureUnit server-side.
  var tempUnit = _brandingData.temperatureUnit === "f" ? "f" : "c";

  container.innerHTML =
    '<div class="settings-cards-row">' +
    '<div class="settings-card">' +
      '<h4>Application Name</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'Change the name shown in browser tabs and PDF exports. ' +
        'On the login page and in the sidebar it is printed <strong>only beside a custom logo</strong> — ' +
        'the Polaris logo already spells the name out, so it is not repeated underneath. ' +
        'Leave it blank if your own logo carries your wordmark.' +
      '</p>' +
      '<div class="form-group"><label>Application Name</label>' +
        '<input type="text" id="f-brand-appname" value="' + escapeHtml(_brandingData.appName || "") + '" placeholder="e.g. Polaris">' +
      '</div>' +
      '<div class="form-group"><label>Subtitle</label>' +
        '<input type="text" id="f-brand-subtitle" value="' + escapeHtml(_brandingData.subtitle || "") + '" placeholder="e.g. Network Management Tool">' +
        '<p class="hint">Shown beneath the application name on the sidebar and login page.</p>' +
      '</div>' +
      '<button class="btn btn-primary" id="btn-brand-save">Save</button>' +
    '</div>' +
    '<div class="settings-card">' +
      '<h4>Logo</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'Upload a custom logo to replace the Polaris one. Recommended size: 280\u00d7280px or larger. Supported formats: PNG, JPEG, WebP. ' +
        'Wherever your logo is switched off below, Polaris shows its own mark in the version that suits the current theme.' +
      '</p>' +
      '<div style="display:flex;align-items:flex-start;gap:1.5rem;flex-wrap:wrap">' +
        '<div style="flex-shrink:0">' +
          '<div class="logo-preview-box">' +
            '<img id="logo-preview" src="' + escapeHtml(previewSrc) + '" alt="Current logo">' +
          '</div>' +
          '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin-top:0.5rem;text-align:center">' +
            (isCustomLogo ? 'Custom logo' : 'Polaris logo') +
          '</p>' +
        '</div>' +
        '<div style="flex:1;min-width:200px">' +
          '<div class="upload-area" id="logo-upload-area">' +
            '<input type="file" id="logo-file-input" accept="image/png,image/jpeg,image/webp">' +
            '<strong style="color:var(--color-text-primary)">Upload New Logo</strong>' +
            '<p>Click to select an image file</p>' +
          '</div>' +
          (isCustomLogo
            ? '<button class="btn btn-secondary" id="btn-logo-reset" style="margin-top:0.75rem">Reset to Default</button>'
            : '') +
        '</div>' +
      '</div>' +
      // Placement + accent. Shown always so the options are discoverable, but
      // inert without a custom logo \u2014 they only choose where YOUR logo goes.
      '<div style="margin-top:1.25rem;border-top:1px solid var(--color-border);padding-top:1rem' +
        (isCustomLogo ? '' : ';opacity:0.55') + '">' +
        '<label style="display:flex;align-items:flex-start;gap:0.5rem;margin-bottom:0.6rem">' +
          '<input type="checkbox" id="f-logo-on-login"' + (logoOnLogin ? ' checked' : '') + (isCustomLogo ? '' : ' disabled') + ' style="margin-top:0.2rem">' +
          '<span><strong>Show my logo on the login page</strong>' +
            '<span style="display:block;font-size:0.78rem;color:var(--color-text-tertiary)">Off: the Polaris wordmark is shown there instead.</span>' +
          '</span>' +
        '</label>' +
        '<label style="display:flex;align-items:flex-start;gap:0.5rem;margin-bottom:0.6rem">' +
          '<input type="checkbox" id="f-logo-on-sidebar"' + (logoOnSidebar ? ' checked' : '') + (isCustomLogo ? '' : ' disabled') + ' style="margin-top:0.2rem">' +
          '<span><strong>Show my logo in the top-left corner after login</strong>' +
            '<span style="display:block;font-size:0.78rem;color:var(--color-text-tertiary)">Off: the Polaris mark is shown in the sidebar instead.</span>' +
          '</span>' +
        '</label>' +
        '<label style="display:flex;align-items:flex-start;gap:0.5rem">' +
          '<input type="checkbox" id="f-logo-accent"' + (logoAccent ? ' checked' : '') + (isCustomLogo ? '' : ' disabled') + ' style="margin-top:0.2rem">' +
          '<span><strong>Accent my logo with the Polaris symbol</strong>' +
            '<span style="display:block;font-size:0.78rem;color:var(--color-text-tertiary)">Overlays the Polaris star on the bottom-right corner of your logo, at about 50% of its size.</span>' +
          '</span>' +
        '</label>' +
        '<button class="btn btn-primary" id="btn-logo-placement-save" style="margin-top:0.9rem"' + (isCustomLogo ? '' : ' disabled') + '>Save</button>' +
      '</div>' +
    '</div>' +
    '<div class="settings-card">' +
      '<h4>Display Units</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'Hardware-sensor temperatures are always collected, stored, and alerted on in Celsius. ' +
        'This changes only how they are <strong>displayed</strong> — the asset Hardware Sensors table and ' +
        'sensor charts, the mobile app, the Highest Temperature widget, and the Dash wallboard. ' +
        'Automation thresholds are unaffected and stay in °C.' +
      '</p>' +
      '<div class="form-group"><label>Temperature</label>' +
        '<select id="f-brand-tempunit">' +
          '<option value="c"' + (tempUnit === "c" ? ' selected' : '') + '>Celsius (°C)</option>' +
          '<option value="f"' + (tempUnit === "f" ? ' selected' : '') + '>Fahrenheit (°F)</option>' +
        '</select>' +
        '<p class="hint">Applies to every operator and to the unauthenticated wallboard.</p>' +
      '</div>' +
      '<button class="btn btn-primary" id="btn-tempunit-save">Save</button>' +
    '</div>' +
    _rebootSettingsCardHtml(_rebootSettingsData) +
    '</div>';

  // Wire save buttons — every card PUTs the whole branding payload, so any one
  // of them persists whatever the operator changed on this tab.
  document.getElementById("btn-brand-save").addEventListener("click", function () { saveBranding(false); });
  document.getElementById("btn-tempunit-save").addEventListener("click", function () { saveBranding(false); });
  var placementBtn = document.getElementById("btn-logo-placement-save");
  // Re-render after this one: the preview swaps to (or away from) the
  // server-composited accent version.
  if (placementBtn) placementBtn.addEventListener("click", function () { saveBranding(true); });
  var rebootBtn = document.getElementById("btn-reboot-settings-save");
  if (rebootBtn) rebootBtn.addEventListener("click", saveRebootSettings);

  // Wire logo upload
  wireUploadArea("logo-upload-area", "logo-file-input", uploadLogo);

  // Wire reset button
  var resetBtn = document.getElementById("btn-logo-reset");
  if (resetBtn) {
    resetBtn.addEventListener("click", resetLogo);
  }
}

/**
 * The Reboots card (business rule 115(d)): whether every reboot — now or
 * booked, from the desktop, the phone or the API — must say why. Pure.
 */
function _rebootSettingsCardHtml(s) {
  if (!s) {
    return '<div class="settings-card"><h4>Reboots</h4><p class="empty-state">Could not load the reboot settings.</p></div>';
  }
  return '<div class="settings-card">' +
    '<h4>Reboots</h4>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
      'The Reboot dialog always offers a <strong>Reason</strong> field. It is recorded on the device’s Events, ' +
      'shown in its reboot history, and printed in the results email of a scheduled reboot.' +
    '</p>' +
    '<label style="display:flex;align-items:flex-start;gap:0.5rem">' +
      '<input type="checkbox" id="f-reboot-require-note"' + (s.requireNote ? ' checked' : '') + ' style="margin-top:0.2rem">' +
      '<span><strong>Require a reason for every reboot</strong>' +
        '<span style="display:block;font-size:0.78rem;color:var(--color-text-tertiary)">' +
          'A reboot or a scheduled reboot without one is refused — in the dialog, on the phone and over the API. ' +
          'Reboots an automation books give the automation’s name as their reason. Bookings made before this was turned on still run.' +
        '</span>' +
      '</span>' +
    '</label>' +
    '<button class="btn btn-primary" id="btn-reboot-settings-save" style="margin-top:0.9rem">Save</button>' +
  '</div>';
}

async function saveRebootSettings() {
  var btn = document.getElementById("btn-reboot-settings-save");
  var box = document.getElementById("f-reboot-require-note");
  if (!btn || !box) return;
  btn.disabled = true;
  try {
    var res = await api.serverSettings.rebootPut({ requireNote: box.checked });
    _rebootSettingsData = res.reboot;
    showToast(res.reboot.requireNote ? "A reason is now required for every reboot" : "The reboot reason is now optional");
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

async function saveBranding(rerender) {
  var btns = ["btn-brand-save", "btn-tempunit-save", "btn-logo-placement-save"]
    .map(function (id) { return document.getElementById(id); })
    .filter(Boolean);
  // Remember which were already disabled (the placement block is, without a
  // custom logo) so re-enabling can't hand out a control the card had greyed.
  var wasDisabled = btns.map(function (b) { return b.disabled; });
  btns.forEach(function (b) { b.disabled = true; });
  try {
    var unitEl = document.getElementById("f-brand-tempunit");
    var loginEl = document.getElementById("f-logo-on-login");
    var sidebarEl = document.getElementById("f-logo-on-sidebar");
    var accentEl = document.getElementById("f-logo-accent");
    var data = {
      appName: document.getElementById("f-brand-appname").value.trim(),
      subtitle: document.getElementById("f-brand-subtitle").value.trim(),
      temperatureUnit: unitEl ? unitEl.value : undefined,
    };
    // Omitted rather than sent as undefined-ish: the PUT falls back to the
    // stored value per field, so a card that didn't render these can't clear them.
    if (loginEl)   data.logoOnLogin   = loginEl.checked;
    if (sidebarEl) data.logoOnSidebar = sidebarEl.checked;
    if (accentEl)  data.logoAccent    = accentEl.checked;
    _brandingData = await api.serverSettings.updateBranding(data);
    applyBranding(_brandingData);
    // Same URL, new bytes when the accent flipped — force the live sidebar to
    // re-fetch so the operator sees the change without a reload.
    PolarisBrandLogo.applyTo(document.querySelector(".sidebar-logo"), _brandingData, "sidebar", { bust: true });
    showToast("Branding saved");
    if (rerender) renderCustomizationTab();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    btns.forEach(function (b, i) { b.disabled = wasDisabled[i]; });
  }
}

async function uploadLogo(files) {
  if (!files || files.length === 0) return;
  var file = files[0];
  if (!file.type.startsWith("image/")) {
    showToast("Please select an image file", "error");
    return;
  }
  try {
    _brandingData = await api.serverSettings.uploadLogo(file);
    applyBranding(_brandingData);
    // The upload route reuses one filename, so the sidebar's <img> URL didn't
    // change even though the image did — force it to re-fetch.
    PolarisBrandLogo.applyTo(document.querySelector(".sidebar-logo"), _brandingData, "sidebar", { bust: true });
    renderCustomizationTab();
    showToast("Logo uploaded");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function resetLogo() {
  var ok = await showConfirm("Reset to the default logo?");
  if (!ok) return;
  try {
    _brandingData = await api.serverSettings.deleteLogo();
    applyBranding(_brandingData);
    // The upload route reuses one filename, so the sidebar's <img> URL didn't
    // change even though the image did — force it to re-fetch.
    PolarisBrandLogo.applyTo(document.querySelector(".sidebar-logo"), _brandingData, "sidebar", { bust: true });
    renderCustomizationTab();
    showToast("Logo reset to default");
  } catch (err) {
    showToast(err.message, "error");
  }
}


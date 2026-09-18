// public/js/reservation-notes.js
//
// How much of a reservation's notes fit on the FortiGate, shared by the desktop
// IP panel and the two mobile reserve/edit sheets.
//
// FortiOS holds 255 characters in a DHCP `reserved-address` description, and
// Polaris writes that field as "Polaris/<user>: <notes> [<hostname>]" so a
// FortiGate admin can see which entry Polaris owns and who pushed it. The
// wrapper is inside the same 255, so the room left for notes shrinks with the
// operator's username and the hostname — which is why this is a computed budget
// and not a fixed maxlength.
//
// Advisory only (business rule 74): src/services/reservationPushService.ts is
// what enforces the limit (`assertReservationDescriptionFits`, a 400 at
// create/edit on a push-eligible network). This keeps the operator from typing
// past it and finding out after they hit Save. Keep the two in step — the format string
// lives in `composeDescription` there.
//
// On a network Polaris does not push to, none of this applies: `notes` is a
// free-text column with no device-side field behind it.

(function () {
  var MAX = 255;

  // Characters of NOTES that fit alongside everything Polaris wraps around
  // them. Zero is a legitimate answer — a very long hostname leaves no room,
  // and the caller should say so rather than pretend there is space.
  function budgetFor(hostname, createdBy) {
    var host = (hostname || "").trim();
    var user = (createdBy || "").trim();
    var prefix = user ? "Polaris/" + user + ": " : "Polaris: ";
    // With a hostname the notes are wrapped as "<notes> [<hostname>]" — the
    // bracket pair plus its leading space is the extra 3.
    var overhead = prefix.length + (host ? host.length + 3 : 0);
    return Math.max(0, MAX - overhead);
  }

  // The line under the field. `over > 0` is the state the server would refuse.
  function hintFor(notes, hostname, createdBy) {
    var budget = budgetFor(hostname, createdBy);
    var over = (notes || "").trim().length - budget;
    if (over > 0) {
      return {
        over: over,
        budget: budget,
        text: "Too long for the FortiGate by " + over + " character" + (over === 1 ? "" : "s")
          + " — the device holds " + MAX + " for “Polaris/<user>: <notes> [<hostname>]”.",
      };
    }
    return {
      over: 0,
      budget: budget,
      text: (-over) + " of " + budget + " characters left — the notes become this "
        + "reservation's description on the FortiGate.",
    };
  }

  window.PolarisReservationNotes = {
    MAX: MAX,
    budgetFor: budgetFor,
    hintFor: hintFor,
  };
})();

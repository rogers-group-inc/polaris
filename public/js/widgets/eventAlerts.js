/**
 * widgets/eventAlerts.js — EVENT ALERTS: the uncleared alerts raised by
 * EVENT-triggered automations (trigger.type "event") — an agent disconnecting,
 * a failed integration sync, a discovery error. Every other alert is the
 * Active Alerts widget's.
 *
 * They used to sit in Active Alerts behind a Show/Hide gear toggle. An event
 * rule fires off an audit Event rather than off a reading, so it answers a
 * different question — an operator watching device health reads these as
 * noise, the operator watching the integrations wants exactly them — and a
 * widget of their own puts them on the boards that want them.
 *
 * Everything but the row predicate is Active Alerts' (the same feed, rows,
 * verbs, sort, export, gear), through PolarisWidgets.registerAlertFeed, so the
 * two cannot drift. Load order: after activeAlerts.js.
 */

(function () {
  PolarisWidgets.registerAlertFeed({
    type: "eventAlerts",
    label: "Event Alerts",
    description: "Alerts raised by event-triggered automations — an agent disconnecting, a failed sync, a discovery error — that nothing has cleared.",
    filename: "event-alerts",
    none: "No event alerts",
    owns: function (r) { return r.triggerType === "event"; },
  });
})();

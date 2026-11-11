/**
 * src/services/notificationTypes.ts
 *
 * Central vocabulary for the notification rules engine: the discriminated
 * `trigger` union, the asset `scope` selector, severities, clear behaviors,
 * and the operator/metric/field catalogs. Shared by the rule routes
 * (validation), the engine (evaluation), the rule service (scope match), and
 * the schema endpoint that drives the builder UI — so the vocabulary lives in
 * exactly one place and the frontend never hardcodes it.
 *
 * CQ-B063: the vocabulary itself now lives in src/services/notificationTypes/*.ts
 * (scope conditions, triggers, actions, specificity, the rule schema, the action
 * walk, metric metadata, alert groups, the builder vocabulary); this file is the
 * one import path every consumer keeps, re-exporting each public name.
 */

// CQ-B063 — grouped alerts + delivery ownership (rule 75) (notificationTypes/alertGroups.ts).
export { type AlertMember, type SpanCounts, countNoun, wholeGroupSubject, groupKeyOf, ruleGroupsByAsset, ALERT_GROUP_FOLD_BY, type AlertGroupFoldBy, foldSpansDevices, subnetFoldTarget, automationFoldTarget, WHOLE_GROUP_FOLD_TARGET, triggerCanJoinGroup, alertScopeOf, activeMembers, mergeMembers, markMemberLeft, type GroupChange, classifyGroupChanges, describeGroupChanges, type PendingGroupChanges, queueGroupChanges, refreshMemberContext, memberMatches, groupSeverity, primaryMember, renderMemberList, type DeliveryOwner, alertOwnerOf, dimensionSpaceOf, dimensionNounOf, buildSchemaCatalog, scopeConditionMeta } from "./notificationTypes/alertGroups.js";

export { WINDOWED_RATIO_METRICS, FORECAST_HORIZON_METRICS, forecastDaysOf, type ForecastLevel, forecastLevelsOf, forecastLevelsSourceId, isForecastLevelSource, linkForecastLevels, readingAtOrAboveCeiling, probeLossWindowSec, probeLossWindowSecFromTrigger, METRIC_META, FIELD_META, CHANGE_TYPE_META, interfacePatternMatch, hwSensorFilterMatches, pathCheckFilterMatches, interfaceTagMatch, memberIpPasses, triggerDimensionApplicable } from "./notificationTypes/metricMeta.js";

// CQ-B063 — the action walk, reset matching (rule 145), follow-up policy (notificationTypes/actionWalk.ts).
export { type RuleActionCarrier, type RuleActionRef, allRuleActionRefs, ruleHasAnyEscalation, escalationTierStateKey, REPEAT_STATE_KEY, repeatStateKey, effectiveAckNoteForSeverity, repeatingActionsForSeverity, allRepeatsOf, escalationChainsForSeverity, type EscalationFiredRecord, parseEscalationFired, appendEscalationFired, expandResetActions, refreshMatchedResetSnapshots, followUpPolicy, isAssetScopedTrigger } from "./notificationTypes/actionWalk.js";

export { type RuleInput, type PreviewRuleInput, actionsToTargets, legacyMirrorOfV2, priorityTagSubjectOf, ruleInputSchema, previewInputSchema, normalizeEscalationToV2, normalizeRuleToV2, parseSeverityBands } from "./notificationTypes/ruleSchema.js";

export { scopeRankLabel, scopeRank, type ScopeAsset, scopeIsUnconstrained, scopeMatchesAsset, triggerSignature, type ShadowIndex, buildShadowIndex, isAssetShadowed, DEFAULT_MISSED_POLLS, isDownDetectionTrigger, ruleAlertsWhenDependencyDown, downRecoverySustainSec, downRecoveryPolls, downRecoveryConsumesSustain, DOWN_ALERT_HOLDING_STATES, DEVICE_FILTER_DIMENSIONS, type DeviceFilterAsset, deviceFilterMatch } from "./notificationTypes/specificity.js";

export { CHANNEL_TYPES, type ChannelType, CHANNEL_TRANSPORT, CHANNEL_TYPE_META, MAX_DEVICE_REGION_LEVELS, emailRecipientsSchema, emailCompositionSchema, escalationSchema, RESET_EVENT_SUGGESTIONS, SCRIPT_INTERPRETERS, type ScriptInterpreter, notifyChannelIds, rebootActionHasTo, actionSchema, escalationV2Schema, repeatConfigSchema, type RepeatConfig, escalatableActionSchema, type EscalatableAction, type SeverityBand, type BandNotify, type DeliveryTarget, type EmailRecipients, type EmailComposition, type EscalationTier, type ResetConfig, type ApiCallAction, type AutomationAction, type EscalationV2Config } from "./notificationTypes/actions.js";

export { numMeets, severityForValue, type ResolvedTier, resolveTierLadder, updateTierMetSince, sustainedSeverity, leadingRun, rollingAggregate, prepareResponseTimeWindow, triggerWindowPolls, advanceRun, sustainedSeverityByRun, triggerHoldPolls, resetSustainPolls, bandDescent, tierMetSinceChanged, PATH_SERVER_LABEL, isPathMetric, isPathTrigger, pathTriggerIncludesServer, pathMonitorScope, eventMatchesPathServer, scopeForTrigger, CHANGE_TYPE_ACTIONS, type CompositeLeaf, type TriggerConditionGroup, isTriggerLeaf, type CompositeTrigger, type Trigger, type RuleScope, parseMemberIpFilter } from "./notificationTypes/triggers.js";

export { SEVERITIES, ALERT_EMAIL_SENT_ACTION, eventFeedsAutomations, type Severity, severityRank, SCOPE_FIELD_OPS, DEVICE_FILTER_FIELD_OPS, type ScopeConditionRule, type ScopeConditionGroup, scopeConditionSchema, deviceFilterConditionSchema, SCOPE_CONDITION_MAX_DEPTH, SCOPE_CONDITION_MAX_RULES, scopeConditionStats, conditionFields, RELATION_CONDITION_FIELDS, conditionNeedsInterfaces, parseVlanId, positiveNativeVlans, conditionNeedsApVaps, conditionNeedsManagedAgent, MANAGED_AGENT_CONDITION_SELECT, type ScopeConditionAsset, positiveStringOp, relationLeafKey, isSubnetNameLeaf, subnetNameLeafKey, evaluateScopeCondition, scopeSchema, scopeCidrOf } from "./notificationTypes/scopeConditions.js";

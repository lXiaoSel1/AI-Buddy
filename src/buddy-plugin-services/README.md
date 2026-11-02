# Buddy bridge v1 — host integration

`createBuddyPluginServices(options)` is a core-only object. Expose **only** its
`invoke(request, {signal})` method across an authenticated plugin channel, and
obtain `pluginId` from that channel rather than plugin JSON. Never expose the
authority, grants, evidence registration or issue methods as renderer IPC.

```js
const services = createBuddyPluginServices({
  resolveContext: async hostSpec => ({
    ...hostSpec,
    ...await game.workScope(hostSpec.characterId, hostSpec.personaId),
    contextRevision: /* authoritative selected card/persona revision */,
  }),
  getGame: () => game,
  getProvider: () => provider,
  onUsage: receipt => authoritativeLedger.record(receipt),
  onNotification: notification => scopedUi.publish(notification),
  registerPage: async registration => /* host-validated page + disposer */,
  registerLifecycle: async registration => /* managed lifecycle + disposer */,
});
services.grants.set({pluginId, declared, granted, enabled: true});
const issued = await services.issueContext({
  pluginId, characterId, personaId, sessionId, taskId,
  workspace: {id, path}, permissionScope, connectionRefs,
});
```

The resolver runs at issue and on **every** call. It must derive identity,
revision, allowed connections and task scope from host authority. Changing a
visible role need not invalidate another running session; changing that
session's life, persona/card revision, approved scope or connections does.
The default TTL is five minutes and the maximum one hour. Reissue from trusted
session metadata when necessary; plugin-supplied IDs are not an alternative.
Effective capabilities are declaration ∩ explicit grant ∩ issued scope.

Serializable calls:

| Method | Capability | Payload / result |
|---|---|---|
| `character.context` (`characters.getContext`) | `characters.getContext` | `{query?}`; existing scoped character/context service |
| `model.request` (`models.request`) | `models.request` | `{connectionRef,messages:[{role,content}],system?,maxTokens?,background?}`; captured connection summary and sanitized result parts |
| `memory.appendEvent` | `memory.appendEvent` | `{evidenceId}`; existing core work-experience source only after host-observed completion **and** presentation |
| `usage.record` | `usage.record` | `{evidenceId}`; verified native usage to core accounting, no invented usage |
| `notifications.publish` | `notifications.publish` | `{id?,title,text}`; fixed character/persona/life/task scope |
| `pages.register` (`ui.registerPage`) | `ui.registerPage` | plugin-namespaced page descriptor; host validates URL/origin/assets and returns disposer |
| `lifecycle.register` | `lifecycle.register` | plugin-namespaced lifecycle descriptor; host owns callbacks and cleanup |

Only the host may call `registerEventEvidence({pluginId,contextToken,evidence})`
or `registerUsageEvidence(...)`. Each evidence `id` is immutable. Presentation
is a separate actual event, not a plugin boolean. Unpresented/incomplete records
are passed to optional `onEvidence` and never written as long-term memory.
Completed, presented work sources call the existing `game.recordWorkExperience`;
there is no second persona, memory, affection or wallet database here.

Usage evidence requires `nativeRequestId`, `accounting` (`independent`,
`parent-total`, or `child-detail`), and observed `usage` (or `null` when unknown).
Child detail is non-billable; the parent total is not added a second time.
The core `onUsage` sink must persistently deduplicate the supplied
`idempotencyKey` across restarts. Model requests are already accounted by the
existing ModelRouter, so the broker does not report their usage again.

Native tool backends use host-only
`authorize({pluginId,contextToken,capability,payload?}) -> {context,generation}`
with `tools.list` / `tools.invoke`, and
`checkAuthorization({...request,generation})` before invoking or returning an
asynchronous tool. This does not read character data or run a model.

The host resolver also attests `planState` (`planning` or `execution`, omitted
means `planning`), `readOnlyToolNames` (default `[]`), and
`approvedPlanRevision` (a bounded nonempty string or `null`). The authority
preserves these fields and rejects every token whose current host state changed.
Native backends must read only the authorized `checked.context`, never caller
options. A plugin payload cannot change planning state, tool allowlists, or the
approval revision. Stage W will issue execution state only from the approved
plan transaction; isolated Stage C tool fixtures may explicitly attest their
own approved execution context.

## Durable native usage receipts

`createPluginUsageRecorder({dataRoot,onRecorded?})` is exported from
`../plugin-usage-recorder.mjs`. Pass `value => recorder.record(value)` as
`onUsage`; return its result so `usage.record` can report conservative
billability. Close it on application shutdown. It serializes writes and uses
`plugin-usage-index-v1/receipts.sqlite` as the authoritative deduplication/outbox
index, with a durable derived `plugin-usage.jsonl` consumed by the existing
TokenMonitor and usage repository. Exactly one application-owned writer is
required. `onRecorded` runs only for newly durable receipts; duplicate callbacks
are suppressed across restarts. Monitor startup reads repaired outbox records
even if a crash prevented a callback.

The immutable key is the host-issued
`pluginId:sessionId:nativeRequestId`. Missing native IDs remain `null`; local
receipt UUIDs identify observations and are never represented as native request
IDs. Conflicting evidence for one key is rejected. The JSONL append is fsynced;
recovery checks exact recorded offsets before exporting a pending receipt again.
Interrupted JSONL tails are retained. The monitor also deduplicates stable
native request IDs if a recovered or copied receipt appears more than once.

The host-only evidence registration preserves an explicit metadata whitelist:
`engine`, `model`, `provider`, `nativeSessionId`, `nativeProfileId`, `usageMode`,
`cumulative`, `origin`, cache/reasoning inclusion flags, `connectionIdentity`,
native `timestamp` (or `at`), and `purpose`. Workspace, task, session and
character/persona/life/operation are fixed by the trusted context. Plugin
`usage.record` payloads only select the host evidence ID; payload fields cannot
invent or override those facts. No API credential is persisted.

Every independently counted receipt requires explicit `accounting`
(`independent` or `parent-total`), `usageMode` (`request`, `delta`, or
`cumulative`), source identity, and enough nonnegative safe-integer counters for
an actual total. `request` and `delta` preserve their actual observed usage and
are ingested as individual requests. `cumulative` requires a separate actual
`cumulative` counter object; a delta is never used to fabricate it. Counter mode
is fixed within a native stream; a mode change remains unknown. Raw known
fields are retained even when the whole observation cannot be counted.

| Origin / relation | Current Stage C accounting |
|---|---|
| `native-log` | diagnostic mirror; the authoritative registered native source counts it |
| `core-model-router` | diagnostic mirror; the existing core API source counts it |
| `managed-receipt` | independent only with attested engine + native session + native request + explicit mode/counters |
| `plugin-request` | independent non-native API event only; known native engines require explicit native origin |
| `child-detail` | diagnostic, linked to parent; parent total alone counts |
| missing IDs, origin, mode, counters, invalid totals | `unknown`, no invented totals, visible missing-usage evidence |

**Stage W prerequisite:** register every readable managed-engine native log
directory as the authoritative TokenSources input. Use `native-log` for its
receipt mirrors. Only when that native log cannot be read may the host attest
`managed-receipt` as the single independent authority, with full real native
IDs/counters/mode. This Stage C implementation deliberately does not guess a
cross-ledger fallback and does not establish any real engine usage accounting.
Changing authority later requires a coordinated migration; never independently
enable both authorities for the same native session. The native-source
registration and this gate belong to the Stage W execution host, not a plugin
payload.

`revokePlugin(id)` revokes grants/tokens, aborts active broker calls, unregisters
pages/lifecycle hooks and waits for those calls to settle. `busy(id?)` reports
these calls. Backend processes remain the runtime manager's responsibility;
process separation is not an OS sandbox.

## Cold work archives

`createColdWorkArchiveBridge({legacyRoot,pendingRoot,readPluginEvidence?,isBusy?})`
exports `assertIdle`, `snapshot`, `restore`, `pending`, `flush`. Construction does
not create a directory or read/recover task records. `snapshot` reads old journal
hash chains or an explicitly supplied read-only plugin evidence provider.
`restore` writes only immutable, atomic pending evidence with
`executionAllowed:false` and paused task mappings; it never modifies the old
journals, user project or native session and never starts a process/queue.

`isBusy(characterId)` must be synchronous. When the business plugin is enabled,
the host should route its live snapshot/restore through the plugin's own
checkpointed data service. When absent/disabled, use this cold bridge so existing
v2 life archives remain exportable/restorable. The future business migration
consumes pending evidence idempotently; this module deliberately does not perform
that migration or replay any queued work.

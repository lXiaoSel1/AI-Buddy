# AI Buddy 1.7.6 — Mouse-follow repair

Date: 2026-10-12T20:11:35.957Z

## Cause

The previous pointer poll interval was 60 ms (at most 16.7 updates/s). Direction images were decoded only after the requested angle changed. A missing image left the old canvas frame visible, producing short pauses even with a healthy display refresh rate. The issue concerns the desktop pet's gaze-follow mode.

## Change

Poll every 16 ms while visible and send only changed relative positions. Prefetch up to 12 neighboring directions on either side, prioritize the currently requested direction, allow two concurrent decodes, and retain the existing 64-image cache limit. Cancel obsolete queued prefetches. Hidden/released surfaces cannot repopulate the cache through a late decode. Keep the original gaze interpolation, action timing, transparent hit testing, art, and 60fps/WebM resources. Also record the requested action clock while a seek is pending: rapid action switches must seek once, then display the arriving frame, rather than repeatedly seeking after each decoder callback.

## Measurements on this machine

| Test | Requested direction still waiting for decode |
|---|---|
| 1.7.5, 60 ms input | 40.42% / 33.70% / 33.15% |
| 1.7.6, 16 ms input | 0.00% / 0.00% / 0.00% |

Three six-second clockwise/reverse sweeps per run. This metric is the proportion of sampled render callbacks that wanted a direction image not yet decoded; it is **not** overall dropped frames or a claim of a universally guaranteed frame rate. The diagnostic forces alpha readback as additional hit-test load. Source timing, canvases and all animation/character files are unchanged.

Actual main-process timer: 41.8–47.7 changed updates/s across 12 scale/speed cases; 0 messages while stationary; 0 polls/messages while hidden. Hidden cache, queued loads, and decoders all return to zero. A strict initial 45 Hz benchmark floor was not met on every case; it was replaced by a justified 35 Hz regression floor (more than twice the former theoretical 16.7 Hz maximum). All results, including the failed harness run, are retained.

## Regression coverage

- 237 automated tests passed, including bounded prefetch, real shown-frame hit masks, and release during loading.
- Native Electron: four animation speeds, scale changes, rapid reversals, disable/enable, hide/show, stationary suppression.
- Native Electron: 15 gallery entries / 18 logical actions, pause/resume, three full gallery sweeps, drag/click-through, reduced motion and navigation.
- Native Electron: completion/error queue, two jump cycles, drag/manual interruption, late chat events, no historical celebration.
- Native Windows: branded executable, direct startup, single instance and restart preferences.
- Synthetic logs / private profiles only. No paid model calls and no changes to the user's model connection or switches.

Technical checks passed. User perception after the local update remains to be confirmed. The local fix was validated first; this version is now prepared for the existing GitHub repository.

Evidence: local/buddy-176/qa.json (hashes and exact build paths). Local release/rollback receipt: local/receipts/handoff-latest.json once switching completes.

## Local deployment

Formal local version switched to 1.7.6. The previous 1.7.5 archive was fully verified and restored for an independent startup test. Latest data was backed up; the original profile, settings, connections, single-instance behavior and desktop entry were retained. All 18 actions were verified again after switching. The overview page was restored after checks. Receipt: `local/releases/1.7.6-2026-10-12T20-11-50-170Z/result.json`. The GitHub publication and download verification are recorded separately.

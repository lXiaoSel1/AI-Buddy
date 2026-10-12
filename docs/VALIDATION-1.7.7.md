# AI Buddy 1.7.7 — Mouse-follow stutter repair

Date: 2026-10-12T21:44:31.498Z

## Symptom

Circling the mouse around the desktop pet, clockwise or counter-clockwise, made the gaze stall and fail to keep up; faster circles were worse. 1.7.6 only validated one slow trajectory (120°/s).

## Causes

1. A direction still that was not decoded yet left the previous frame on screen (`draw` returned without drawing).
2. The look sequence has 180 lossless 576×624 WebP stills (~20 ms to decode each, two at a time), but only 64 fitted in the cache, so every full circle decoded all of them again; a ±12-frame prefetch covered roughly 33 ms of a fast circle.
3. Every superseded "current" request kept top priority and was never dropped, so it decoded ahead of the neighbours actually needed.
4. Equal-distance neighbours always decoded the clockwise one first.
5. The gaze restarted a 180 ms ease along the shortest arc on every pointer sample; once a fast circle put it half a turn behind, the shortest arc pointed backwards and the gaze turned the wrong way.
6. While the pointer was over the pet, every new frame triggered a full-canvas `getImageData` for the hit mask.

## Change

- Direction stills are scaled once to the pet canvas size (`createImageBitmap`) and kept in a dedicated cache under a 128 MiB byte budget; following warms all 180 in the background (anchors first). If a size cannot hold all of them, the 36 original frames stay resident as anchors and the rest are LRU.
- A missing direction draws the nearest decoded one (along the turn) instead of freezing.
- Direction requests outside the current window are cancelled; prefetch extends ahead of the motion with its speed (up to 40 frames) and has no side bias at rest.
- The gaze eases along an unwrapped angle accumulated from successive pointer samples, so it never reverses; a half-turn jump keeps the current turning direction. Slow movement keeps the 180 ms glide; fast circles shorten it to 90 ms at 1440°/s and above.
- Hit testing reads only the pixel under the pointer.

Code only: `src/pet-actions.mjs` and `src/video-sequence-renderer.mjs`. All character art and animation bytes, the main process and the monitoring worker are byte-identical to 1.7.6.

## Measurements on this machine (1.7.6 → 1.7.7)

Actual Electron, isolated profiles, synthetic pointer at 16 ms, 4 s per trajectory after a 3 s still pre-roll, scale 1 / DPR 1. Exact = rendered direction equals the wanted one; stall = longest time the picture stayed on a wrong frame while the wanted direction moved; backward = gaze steps against the turning direction; lag = mean gaze delay behind the pointer angle; decodes = still decodes during the trajectory.

| Trajectory | Exact | Longest stall | Backward | Lag | Decodes |
|---|---|---|---|---|---|
| cw-120 | 100.0% → 100.0% | 0 ms → 0 ms | 0 → 0 | 6° → 6° | 248 → 0 |
| ccw-120 | 100.0% → 100.0% | 0 ms → 0 ms | 0 → 0 | 6° → 6° | 265 → 0 |
| cw-720 | 24.5% → 100.0% | 424 ms → 0 ms | 0 → 0 | 37° → 30° | 1065 → 0 |
| ccw-720 | 26.7% → 100.0% | 445 ms → 0 ms | 0 → 0 | 37° → 30° | 1092 → 0 |
| cw-1440 | 30.9% → 100.0% | 243 ms → 0 ms | 0 → 0 | 74° → 34° | 1835 → 0 |
| ccw-1440 | 24.1% → 100.0% | 327 ms → 0 ms | 0 → 0 | 73° → 34° | 1786 → 0 |
| cw-2880 | 60.5% → 100.0% | 83 ms → 0 ms | 171 → 0 | 87° → 68° | 1314 → 0 |
| ccw-2880 | 64.0% → 100.0% | 111 ms → 0 ms | 165 → 0 | 87° → 68° | 1286 → 0 |
| cross-center | 100.0% → 100.0% | 0 ms → 0 ms | 0 → 0 | 49° → 29° | 890 → 0 |
| random | 85.3% → 100.0% | 355 ms → 0 ms | 0 → 0 | 27° → 20° | 834 → 0 |

- Cold start (no pre-roll, fast circle first): 1.7.6 longest stall 521 ms; 1.7.7 5 ms, all 180 directions resident after about two seconds.
- Scale 1.5 / DPR 1.5: all 180 directions resident (102.7 MiB), every trajectory exact, longest stall 0 ms.
- Scale 1.5 / DPR 2 (largest setting, does not fit the budget): anchors + window, 64–84% exact with near-neighbour frames otherwise, longest stall 27 ms, no backward steps, 127.8 MiB of 128.0 MiB.
- Hit-test cost p95: 4.9 ms → 0.1 ms.
- Pointer input unchanged: 41.5–48.5 updates/s over 12 scale/speed cases; none while stationary or hidden; hidden releases every cached direction (0 frames, 0 bytes).

## Regression coverage

- 243 automated tests passed (6 new: no backward gaze at 120–5400°/s both ways, half-turn jumps, nearest-frame fallback, stale-request cancellation, unbiased prefetch, byte budget and one-pixel hit test).
- Native Electron: 18 logical actions / 15 gallery entries, three gallery sweeps, completion/error feedback queue, drag and click-through, hide/show, follow on/off.
- Native Windows: branded executable, direct startup, single instance and restart preferences.
- No paid model or image requests; synthetic logs and private profiles only.

## Acceptance and limits

The user tried the isolated 1.7.7 trial beside 1.7.6 and confirmed the feel. Measurements use a synthetic pointer on this machine, not the real OS cursor or the user's laptop. Gaze lag still grows with very fast circles (about 68° at 2880°/s), by design of the smoothing.

Evidence: local/buddy-177/qa.json (hashes and exact build paths).

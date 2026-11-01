# CourtVision

A smartphone-first tennis app: record a match live, keep the last 10–20 seconds ready as a replay, review
footage frame by frame, calibrate the court, and — as a clearly labelled experiment — get bounce candidates
with IN / OUT / UNCERTAIN estimates.

Built as a web-first installable PWA so it runs from a URL with no app-store accounts.

> **Product guardrail:** live recording and replay come first; automated officiating is experimental. A
> single fixed camera cannot resolve every bounce, so the system is designed to answer `UNCERTAIN` whenever
> the footage does not support a confident call. Never present these calls as official decisions.

## What is implemented

| Area | Behaviour |
| --- | --- |
| Live camera preview | `getUserMedia` rear camera, framing guide, resolution/low-power controls |
| Live match recording | `MediaRecorder` to local chunks, match timer, pause/resume, storage + size readout |
| Rolling replay buffer | Chunk ring of the last 10/15/20 s, one-tap save as a stored replay clip |
| Video review | Scrub, 0.25×/0.5× playback, frame stepping, timecode, full-clip download, ±2.5 s segment export |
| Court calibration | Tap court keypoints on a real frame, DLT homography, projected court overlay, RMS fit quality |
| Ball detection & tracking | On-device colour-blob baseline over sampled frames, nearest-neighbour tracks |
| Bounce candidates | Trajectory turning points + track-end fallback, with confidence and quality flags |
| Line-call estimate | Metres from the nearest line, uncertainty band, IN/OUT/UNCERTAIN with evidence frames |
| Match dashboard | Local sessions, clip counts, markers, analysis status, deletion |
| Storage | IndexedDB (`matches`, `media`, `analysis`); nothing is uploaded |

Deliberately **not** built: server upload/queue, multi-camera reconstruction, official-grade live umpiring,
tournament administration. See "Not in this build" below.

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
```

Camera access needs a secure context. `localhost` counts, so desktop testing works. On a phone either:

- serve over HTTPS: `npm run dev -- --experimental-https` (accept the self-signed certificate), or
- run a tunnel (ngrok/cloudflared) to the dev server, or
- `npm run build && npm start` behind an HTTPS proxy.

Production build:

```bash
npm run build
npm start
```

Install to the home screen from the browser menu; a service worker caches the app shell (clips always stay
in IndexedDB, and recording never depends on the network).

## Using it

1. **Record a match** — grant camera, frame the whole court, pick singles/doubles and a buffer length, start.
2. **Save replay** — after a disputed point, tap *Save replay*. The previous seconds are already buffered;
   the clip is written locally with its match offset.
3. **Mark disputed points** — markers and notes are stored with match timestamps.
4. **Review** — open the session, select a clip, scrub / slow down / step frames. *Export ±2.5 s* re-records
   a segment through `captureStream`; *Download clip* saves the original file untouched.
5. **Calibrate** — switch to *Court calibration*, pause on a clear frame and tap the court points. Four
   corners are enough to start, adding singles/net points improves the fit. Save when it looks right.
6. **Analyse** — run the AI pass on a replay clip. Bounce candidates appear with call, distance to the
   nearest line, 1σ uncertainty, quality flags and original evidence frames. JSON export included.

## How the analysis works

Everything runs in the browser on sampled frames (`lib/analysis.ts`); recording is a separate path and is
never blocked by it.

1. **Sampling** — up to 400 frames (~every 40 ms for short clips, sparser for long ones). Sparse sampling is
   reported as a warning.
2. **Detection** — baseline HSV-ish colour gate for a yellow-green ball, connected components, size / aspect /
   fill filters. Confidence comes from blob size and compactness. This is a feasibility detector, not a model.
3. **Tracking** — nearest-neighbour linking with velocity prediction, gaps up to 3 sampled frames, minimum
   track length 3.
4. **Bounce candidates** — smoothed vertical trajectory peaks (ball descends then rises), plus a
   `track_ended_near_ground` fallback at the bottom of the frame.
5. **Court mapping** — the calibrated homography (image px → court metres) projects the bounce frame onto the
   court plane. Uncertainty is propagated from pixel error through the homography and combined with a
   **0.35 m single-camera height term**, because the ball's height above the plane is unknown.
6. **Decision** — `lib/linecall.ts`: if `distance_to_line <= 2σ`, or `σ > 1.0 m`, or the bounce projects far
   outside the calibrated court, the result is `UNCERTAIN`. Otherwise `IN` / `OUT` for the chosen format.
   Thresholds are provisional and must be recalibrated against measured validation data.
7. **Evidence** — up to four original frames per candidate are stored with the result.

Calibration quality is the RMS pixel error of the court keypoints projected back onto the frame; it is shown
throughout the UI and feeds the uncertainty estimate.

### Why UNCERTAIN appears so often

A homography maps the **court plane**. A ball in flight is above that plane, and at bounce the true contact
point can be hidden by motion blur, the ball's own size, or an occluding player. The prototype therefore
refuses calls inside the uncertainty band rather than guessing. Multi-camera or calibrated high-speed capture
is the credible path to fewer abstentions.

## Repo map

```
app/                 Next.js App Router pages (dashboard, /record, /match/[id])
components/          LiveSession, MatchReview, CourtOverlay, MatchList
lib/analysis.ts      Frame sampling, blob detection, tracking, bounce candidates, evidence
lib/calibration.ts   Keypoint → homography, court ↔ frame projection, quality rating
lib/homography.ts    DLT least squares, inversion, uncertainty propagation
lib/linecall.ts      IN / OUT / UNCERTAIN decision logic
lib/court.ts         ITF court geometry, keypoint targets, court lines
lib/recorder.ts      getUserMedia + MediaRecorder session and rolling replay buffer
lib/db.ts            IndexedDB stores (matches, media, analysis)
cv/                  Python proof-of-concept pipeline (offline clip → annotated MP4 + JSON)
```

## Python CV proof of concept (`cv/`)

This is the plan's "practical first milestone": a fixed-camera clip in, annotated MP4 + JSON out.

```bash
cd cv
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python analyze.py --print-template > keypoints.json   # fill in pixel coordinates
python analyze.py ../match.mp4 --keypoints keypoints.json --out output
```

Outputs:

- `output/<clip>-annotated.mp4` — court projection, ball tracks, bounce markers with calls
- `output/<clip>-analysis.json` — timestamps, detections, court points, uncertainty, quality flags

If no keypoints file is supplied the script still tracks the ball but emits `UNCERTAIN` everywhere with a
`no_calibration` flag.

## Known limitations

- Ball detection is a colour heuristic: yellow-green clothing, court surfaces and strong highlights can
  confuse it. Occlusions, low light and motion blur reduce coverage.
- `MediaRecorder` output differs by browser/device (WebM/VP8/VP9, MP4 on Safari). Segment export relies on
  `captureStream`, so it may not work everywhere — full-clip download always does.
- Replay clip durations are approximate: they come from recording timeslices, not frame timestamps. Match
  offsets are wall-clock based.
- Full matches are held in memory until stopped and then stored in IndexedDB. Very long matches can exhaust
  device storage; there is no automatic chunked durable recording yet.
- Calibration assumes a static camera. Moving the phone invalidates the homography.
- Analysis is a single-camera prototype with provisional thresholds; there is no published evaluation yet.

## Not in this build (next steps)

1. Server-side storage/queue (Supabase + FastAPI worker) for heavier analysis and cross-device access.
2. Chunked durable recording so long matches survive backgrounding and reloads.
3. Real ball detector (heatmap model) + measured evaluation: detection recall, localisation error, bounce
   timing/location error, IN/OUT precision/recall, coverage and abstention rate.
4. Train/validation/test split by session, independent ground truth for close calls (second close-up camera).
5. Dual-camera or calibrated high-speed capture to attack the height/contact ambiguity.

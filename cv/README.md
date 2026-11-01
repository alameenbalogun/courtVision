# CourtVision CV proof of concept

Fixed-camera tennis clip in, annotated MP4 + JSON of detections, tracks, bounce candidates and
IN / OUT / UNCERTAIN estimates out. Mirrors the browser pipeline in `lib/analysis.ts` so results can be
compared side by side.

This is a **feasibility baseline**, not an officiating system. It is meant to be run on 10–30 s clips
against manually annotated ground truth.

## Install

```bash
cd cv
python -m venv .venv
. .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Run

```bash
# 1. Write a keypoint template, then fill in pixel coordinates from a frame
python analyze.py --print-template > keypoints.json

# 2. Analyse a clip
python analyze.py clip.mp4 --keypoints keypoints.json --out output
```

Options:

| Flag | Meaning |
| --- | --- |
| `--keypoints PATH` | Court keypoint JSON (see below). Optional; without it calls are `UNCERTAIN`. |
| `--out DIR` | Output directory (default `output`) |
| `--format singles\|doubles` | Court bounds used for IN/OUT (default `singles`) |
| `--max-frames N` | Cap processed frames (default: whole clip) |
| `--print-template` | Print a keypoint JSON template and exit |
| `--no-video` | Skip writing the annotated MP4 |

### Keypoint file

Coordinates are pixels in the source video frame:

```json
{
  "frame": { "width": 1920, "height": 1080 },
  "points": {
    "near-left-out": [310, 1010],
    "near-right-out": [1610, 1010],
    "far-right-out": [1290, 240],
    "far-left-out": [630, 240],
    "near-left-in": [420, 940],
    "near-right-in": [1500, 940],
    "far-left-in": [740, 265],
    "far-right-in": [1180, 265]
  }
}
```

Target ids: `near-left-out`, `near-right-out`, `far-right-out`, `far-left-out` (doubles baseline corners —
these four determine the plane), `near-left-in`, `near-right-in`, `far-left-in`, `far-right-in` (singles
corners), `net-left`, `net-right` (net posts on the doubles lines).

## Output

`output/<clip>-annotated.mp4` — projected court lines, ball track segments, bounce rings labelled with the
call, timestamp and uncertainty.

`output/<clip>-analysis.json` — video checks, calibration fit, tracks, and events shaped like:

```json
{
  "event_type": "candidate_bounce",
  "video_time_ms": 18420,
  "estimated_court_point": { "x": 4.71, "y": 18.9 },
  "distance_to_line_m": 0.06,
  "sigma_m": 0.44,
  "line_call": "UNCERTAIN",
  "confidence": 0.61,
  "quality_flags": [
    "single_camera_court_plane_projection",
    "bounce_location_uncertain",
    "line_call_abstained"
  ]
}
```

## Pipeline

1. **Video checks** — resolution, fps, frame count, mean luma, Laplacian variance (blur proxy). Warnings are
   written into the JSON.
2. **Calibration** — least-squares DLT homography from keypoints, reported as RMS pixel error when court
   points are projected back onto the frame.
3. **Ball detection** — HSV yellow-green gate, morphological cleaning, contour filtering by area/aspect/fill.
   Confidence from size and compactness.
4. **Tracking** — nearest-neighbour association with velocity prediction and a short missed-detection
   tolerance.
5. **Bounce candidates** — smoothed vertical-trajectory turning points, plus a track-end fallback near the
   bottom of frame.
6. **Court mapping and uncertainty** — pixel error propagated through the homography, combined in quadrature
   with a 0.35 m single-camera height term.
7. **Line call** — `UNCERTAIN` if the bounce is within 2σ of a line, σ > 1.0 m, or the projection is far
   outside the court; otherwise `IN`/`OUT` for the selected format.

All thresholds are provisional. Replace them with values derived from a labelled validation set before
making any accuracy claim.

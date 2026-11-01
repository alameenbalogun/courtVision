#!/usr/bin/env python3
"""CourtVision computer-vision proof of concept.

Takes one fixed-camera smartphone clip, optionally a court keypoint file, and
produces an annotated MP4 plus a JSON report of ball detections, tracks, bounce
candidates and IN / OUT / UNCERTAIN estimates.

This is a feasibility baseline. The detector is a colour heuristic and the line
call logic abstains whenever the uncertainty band overlaps a line.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np

COURT = {
    "length": 23.77,
    "doubles_width": 10.97,
    "singles_inset": 1.37,
    "centre_x": 5.485,
    "net_y": 11.885,
    "service_from_net": 6.4,
}
NEAR_SERVICE_Y = COURT["net_y"] - COURT["service_from_net"]
FAR_SERVICE_Y = COURT["net_y"] + COURT["service_from_net"]

# Target ids must match lib/court.ts so keypoints can be copied across tools.
TARGETS = {
    "near-left-out": (0.0, 0.0),
    "near-right-out": (COURT["doubles_width"], 0.0),
    "far-right-out": (COURT["doubles_width"], COURT["length"]),
    "far-left-out": (0.0, COURT["length"]),
    "near-left-in": (COURT["singles_inset"], 0.0),
    "near-right-in": (COURT["doubles_width"] - COURT["singles_inset"], 0.0),
    "far-left-in": (COURT["singles_inset"], COURT["length"]),
    "far-right-in": (COURT["doubles_width"] - COURT["singles_inset"], COURT["length"]),
    "net-left": (0.0, COURT["net_y"]),
    "net-right": (COURT["doubles_width"], COURT["net_y"]),
}

SIGMA_ABSTAIN_M = 1.0
DECISION_SIGMA_MULTIPLIER = 2.0
MAX_PLAUSIBLE_MARGIN_M = 2.0
HEIGHT_UNCERTAINTY_M = 0.35


def court_lines() -> list[tuple[str, tuple[float, float], tuple[float, float], str]]:
    w = COURT["doubles_width"]
    inset = COURT["singles_inset"]
    length = COURT["length"]
    return [
        ("near baseline", (0.0, 0.0), (w, 0.0), "boundary"),
        ("far baseline", (0.0, length), (w, length), "boundary"),
        ("left doubles sideline", (0.0, 0.0), (0.0, length), "boundary"),
        ("right doubles sideline", (w, 0.0), (w, length), "boundary"),
        ("left singles sideline", (inset, 0.0), (inset, length), "inner"),
        ("right singles sideline", (w - inset, 0.0), (w - inset, length), "inner"),
        ("near service line", (inset, NEAR_SERVICE_Y), (w - inset, NEAR_SERVICE_Y), "inner"),
        ("far service line", (inset, FAR_SERVICE_Y), (w - inset, FAR_SERVICE_Y), "inner"),
        ("centre service line", (COURT["centre_x"], NEAR_SERVICE_Y), (COURT["centre_x"], FAR_SERVICE_Y), "inner"),
        ("net", (0.0, COURT["net_y"]), (w, COURT["net_y"]), "net"),
    ]


# --------------------------------------------------------------------------- #
# Calibration
# --------------------------------------------------------------------------- #


def load_keypoints(path: Path) -> dict[str, tuple[float, float]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    raw = payload.get("points", payload)
    points: dict[str, tuple[float, float]] = {}
    for key, value in raw.items():
        if key not in TARGETS:
            continue
        if not isinstance(value, (list, tuple)) or len(value) != 2:
            continue
        points[key] = (float(value[0]), float(value[1]))
    return points


def compute_calibration(points_px: dict[str, tuple[float, float]]):
    if len(points_px) < 4:
        return None, None, None, "Fewer than four court keypoints supplied."

    ids = list(points_px.keys())
    src = np.array([points_px[key] for key in ids], dtype=np.float64).reshape(-1, 1, 2)
    dst = np.array([TARGETS[key] for key in ids], dtype=np.float64).reshape(-1, 1, 2)

    homography, _ = cv2.findHomography(src, dst, 0)
    if homography is None:
        return None, None, None, "Keypoints do not define a court plane."
    try:
        inverse = np.linalg.inv(homography)
    except np.linalg.LinAlgError:
        return None, None, None, "Homography could not be inverted."

    projected = cv2.perspectiveTransform(dst.reshape(-1, 1, 2), inverse).reshape(-1, 2)
    errors = np.linalg.norm(projected - src.reshape(-1, 2), axis=1)
    rms = float(np.sqrt(np.mean(errors**2)))
    if not math.isfinite(rms) or rms > 90:
        return None, None, None, f"Calibration is inconsistent ({rms:.1f} px RMS)."

    return homography, inverse, rms, None


def project(homography: np.ndarray, point: tuple[float, float]) -> tuple[float, float] | None:
    vec = np.array([[[point[0], point[1]]]], dtype=np.float64)
    out = cv2.perspectiveTransform(vec, homography).reshape(2)
    if not np.all(np.isfinite(out)):
        return None
    return float(out[0]), float(out[1])


def propagate_uncertainty(inverse: np.ndarray, point: tuple[float, float], pixels: float) -> float:
    base = project(inverse, point)
    if base is None:
        return float("inf")
    offsets = [
        (pixels, 0.0),
        (-pixels, 0.0),
        (0.0, pixels),
        (0.0, -pixels),
        (pixels * 0.7071, pixels * 0.7071),
        (-pixels * 0.7071, -pixels * 0.7071),
    ]
    worst = 0.0
    for dx, dy in offsets:
        shifted = project(inverse, (point[0] + dx, point[1] + dy))
        if shifted is None:
            return float("inf")
        worst = max(worst, math.hypot(shifted[0] - base[0], shifted[1] - base[1]))
    return worst


# --------------------------------------------------------------------------- #
# Detection and tracking
# --------------------------------------------------------------------------- #


def detect_ball(frame: np.ndarray, min_area: float, max_area: float):
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, np.array([22, 90, 110]), np.array([46, 255, 255]))
    kernel = np.ones((3, 3), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best = None
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < min_area or area > max_area:
            continue
        x, y, w, h = cv2.boundingRect(contour)
        if w < 2 or h < 2:
            continue
        aspect = w / h
        if aspect < 0.3 or aspect > 3.2:
            continue
        fill = area / float(w * h)
        if fill < 0.2:
            continue
        moments = cv2.moments(contour)
        if moments["m00"] <= 0:
            continue
        cx = moments["m10"] / moments["m00"]
        cy = moments["m01"] / moments["m00"]
        confidence = min(0.97, 0.28 + 0.34 * min(1.0, area / 140.0) + 0.34 * math.sqrt(fill))
        candidate = {
            "x_px": float(cx),
            "y_px": float(cy),
            "confidence": float(confidence),
            "area": float(area),
        }
        if best is None or candidate["confidence"] > best["confidence"]:
            best = candidate
    return best


def link_tracks(per_frame: list[dict], gate: float, max_gap: int = 3) -> list[dict]:
    tracks: list[dict] = []

    for index, entry in enumerate(per_frame):
        detection = entry["detection"]
        if not detection:
            continue
        best_track = None
        best_distance = float("inf")
        for track in tracks:
            gap = index - track["last_index"]
            if gap > max_gap:
                continue
            last = track["samples"][-1]
            predicted_x = last["x_px"] + track["vx"] * gap
            predicted_y = last["y_px"] + track["vy"] * gap
            distance = math.hypot(detection["x_px"] - predicted_x, detection["y_px"] - predicted_y)
            limit = gate * (1 + 0.35 * (gap - 1))
            if distance < limit and distance < best_distance:
                best_track = track
                best_distance = distance

        sample = {
            "time_ms": entry["time_ms"],
            "x_px": detection["x_px"],
            "y_px": detection["y_px"],
            "confidence": detection["confidence"],
        }

        if best_track is None:
            tracks.append({"samples": [sample], "last_index": index, "vx": 0.0, "vy": 0.0})
        else:
            last = best_track["samples"][-1]
            gap = index - best_track["last_index"]
            best_track["vx"] = (detection["x_px"] - last["x_px"]) / gap
            best_track["vy"] = (detection["y_px"] - last["y_px"]) / gap
            best_track["samples"].append(sample)
            best_track["last_index"] = index

    kept = [track for track in tracks if len(track["samples"]) >= 3]
    kept.sort(key=lambda item: len(item["samples"]), reverse=True)
    kept = kept[:12]
    return [{"id": f"track-{i + 1}", "samples": track["samples"]} for i, track in enumerate(kept)]


def find_bounces(track: dict, frame_height: int) -> list[dict]:
    samples = track["samples"]
    if len(samples) < 3:
        return []

    ys = [sample["y_px"] for sample in samples]
    smoothed = []
    for i in range(len(ys)):
        window = ys[max(0, i - 2) : min(len(ys), i + 3)]
        smoothed.append(sum(window) / len(window))

    # Prominence is measured over a wide window: vertical velocity is near zero
    # at the bounce, so a +/-2 sample window hides the depth of a fast bounce.
    threshold = 0.006 * max(1, frame_height)
    window = min(6, max(2, len(samples) // 4))
    proposals = []
    for i in range(2, len(samples) - 2):
        peak = (
            smoothed[i] >= smoothed[i - 1]
            and smoothed[i] >= smoothed[i + 1]
            and smoothed[i] > smoothed[i - 2]
            and smoothed[i] > smoothed[i + 2]
        )
        if not peak:
            continue
        left = smoothed[max(0, i - window)]
        right = smoothed[min(len(smoothed) - 1, i + window)]
        prominence = smoothed[i] - max(left, right)
        if prominence < threshold:
            continue
        proposals.append({"index": i, "prominence": prominence, "flags": []})

    last_index = len(samples) - 1
    last = samples[last_index]
    previous = samples[max(0, last_index - 2)]
    if not proposals and last["y_px"] > 0.5 * frame_height and last_index >= 3:
        if last["y_px"] - previous["y_px"] > 0.005 * frame_height:
            proposals.append(
                {
                    "index": last_index,
                    "prominence": max(threshold * 0.5, last["y_px"] - previous["y_px"]),
                    "flags": ["track_ended_near_ground"],
                }
            )

    picked: list[dict] = []
    for proposal in sorted(proposals, key=lambda item: item["prominence"], reverse=True):
        stamp = samples[proposal["index"]]["time_ms"]
        if any(abs(samples[existing["index"]]["time_ms"] - stamp) < 600 for existing in picked):
            continue
        picked.append(proposal)
        if len(picked) >= 2:
            break

    return sorted(picked, key=lambda item: item["index"])


# --------------------------------------------------------------------------- #
# Line calls
# --------------------------------------------------------------------------- #


def court_bounds(fmt: str) -> dict:
    if fmt == "doubles":
        return {"min_x": 0.0, "max_x": COURT["doubles_width"], "min_y": 0.0, "max_y": COURT["length"]}
    return {
        "min_x": COURT["singles_inset"],
        "max_x": COURT["doubles_width"] - COURT["singles_inset"],
        "min_y": 0.0,
        "max_y": COURT["length"],
    }


def evaluate_bounce(point: tuple[float, float], sigma: float, fmt: str) -> dict:
    bounds = court_bounds(fmt)
    inside = (
        bounds["min_x"] <= point[0] <= bounds["max_x"]
        and bounds["min_y"] <= point[1] <= bounds["max_y"]
    )
    edges = [
        ("left sideline", abs(point[0] - bounds["min_x"])),
        ("right sideline", abs(point[0] - bounds["max_x"])),
        ("near baseline", abs(point[1] - bounds["min_y"])),
        ("far baseline", abs(point[1] - bounds["max_y"])),
    ]
    nearest_line, distance = min(edges, key=lambda item: item[1])

    def abstain(reason: str) -> dict:
        return {
            "line_call": "UNCERTAIN",
            "inside_court": inside,
            "distance_to_line_m": float(distance),
            "nearest_line": nearest_line,
            "reason": reason,
        }

    if not math.isfinite(sigma) or sigma <= 0:
        return abstain("No usable uncertainty estimate for this location.")
    if sigma > SIGMA_ABSTAIN_M:
        return abstain(f"Location uncertainty (±{sigma:.2f} m) is too large to place the bounce.")
    if (
        point[0] < -MAX_PLAUSIBLE_MARGIN_M
        or point[0] > COURT["doubles_width"] + MAX_PLAUSIBLE_MARGIN_M
        or point[1] < -MAX_PLAUSIBLE_MARGIN_M
        or point[1] > COURT["length"] + MAX_PLAUSIBLE_MARGIN_M
    ):
        return abstain("Bounce projects far outside the calibrated court; the mapping is not trustworthy.")
    if distance - DECISION_SIGMA_MULTIPLIER * sigma <= 0:
        return abstain(
            f"Bounce is {distance:.2f} m from the {nearest_line}, inside the ±"
            f"{DECISION_SIGMA_MULTIPLIER * sigma:.2f} m uncertainty band."
        )
    return {
        "line_call": "IN" if inside else "OUT",
        "inside_court": inside,
        "distance_to_line_m": float(distance),
        "nearest_line": nearest_line,
        "reason": f"Bounce is {distance:.2f} m from the {nearest_line}, outside the uncertainty band.",
    }


# --------------------------------------------------------------------------- #
# Rendering
# --------------------------------------------------------------------------- #


def draw_court(frame: np.ndarray, inverse: np.ndarray) -> None:
    for _, start, end, kind in court_lines():
        points = []
        for step in range(15):
            t = step / 14.0
            court_point = (start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t)
            projected = project(inverse, court_point)
            if projected is None or not (math.isfinite(projected[0]) and math.isfinite(projected[1])):
                points = []
                break
            points.append((int(round(projected[0])), int(round(projected[1]))))
        if len(points) < 2:
            continue
        colour = (61, 255, 198) if kind == "boundary" else (110, 170, 90)
        thickness = 3 if kind == "net" else 2
        cv2.polylines(frame, [np.array(points, dtype=np.int32)], False, colour, thickness, cv2.LINE_AA)


def draw_event(frame: np.ndarray, event: dict) -> None:
    x = int(round(event["image_point"]["x_px"]))
    y = int(round(event["image_point"]["y_px"]))
    call = event["line_call"]
    colour = {"IN": (120, 255, 120), "OUT": (90, 90, 255)}.get(call, (72, 182, 255))
    cv2.circle(frame, (x, y), 22, colour, 2, cv2.LINE_AA)
    cv2.circle(frame, (x, y), 4, colour, -1, cv2.LINE_AA)
    label = f"{call}  {event['video_time_ms'] / 1000:.2f}s"
    if event.get("distance_to_line_m") is not None:
        label += f"  {event['distance_to_line_m'] * 100:.0f}cm"
    if event.get("sigma_m") is not None:
        label += f"  ±{event['sigma_m'] * 100:.0f}cm"
    cv2.putText(frame, label, (x + 28, y + 6), cv2.FONT_HERSHEY_SIMPLEX, 0.6, colour, 2, cv2.LINE_AA)


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #


def print_template() -> None:
    template = {
        "frame": {"width": 1920, "height": 1080},
        "points": {key: [0, 0] for key in TARGETS},
    }
    print(json.dumps(template, indent=2))


def analyse(args: argparse.Namespace) -> int:
    source = Path(args.clip).expanduser().resolve()
    if not source.exists():
        print(f"Clip not found: {source}", file=sys.stderr)
        return 2

    capture = cv2.VideoCapture(str(source))
    if not capture.isOpened():
        print(f"Could not open clip: {source}", file=sys.stderr)
        return 2

    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))

    warnings: list[str] = []
    keypoints: dict[str, tuple[float, float]] = {}
    calibration_error: float | None = None
    homography = None
    inverse = None

    if args.keypoints:
        keypoints = load_keypoints(Path(args.keypoints))
        homography, inverse, calibration_error, error = compute_calibration(keypoints)
        if error:
            warnings.append(f"Calibration unavailable: {error}")
    else:
        warnings.append("No keypoint file supplied; bounce locations and line calls are unavailable.")

    min_area = max(8.0, width * height * 0.000004)
    max_area = max(200.0, width * height * 0.002)

    per_frame: list[dict] = []
    luma_sum = 0.0
    blur_sum = 0.0
    sampled = 0
    frame_index = 0
    limit = args.max_frames if args.max_frames > 0 else frame_count or 10**9

    while frame_index < limit:
        ok, frame = capture.read()
        if not ok:
            break
        time_ms = (frame_index / fps) * 1000.0
        detection = detect_ball(frame, min_area, max_area)
        per_frame.append({"time_ms": time_ms, "detection": detection})

        if frame_index % 15 == 0:
            grey = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            luma_sum += float(grey.mean())
            blur_sum += float(cv2.Laplacian(grey, cv2.CV_64F).var())
            sampled += 1
        frame_index += 1

    capture.release()

    processed = len(per_frame)
    if processed == 0:
        print("No frames could be read from the clip.", file=sys.stderr)
        return 2

    mean_luma = luma_sum / sampled if sampled else 0.0
    mean_blur = blur_sum / sampled if sampled else 0.0
    if not math.isfinite(mean_luma) or mean_luma < 45:
        warnings.append("Low average brightness; ball detection will be unreliable.")
    if not math.isfinite(mean_blur) or mean_blur < 60:
        warnings.append("Low Laplacian variance suggests soft or blurred footage.")

    duration_ms = processed * 1000.0 / fps
    if duration_ms > 60_000:
        warnings.append(
            "Clip is longer than a minute; this baseline is intended for short review clips."
        )

    tracks = link_tracks(per_frame, gate=max(24.0, width * 0.14))

    events = []
    for track in tracks:
        for proposal in find_bounces(track, height):
            sample = track["samples"][proposal["index"]]
            flags = ["single_camera_court_plane_projection", *proposal["flags"]]
            confidence = sample["confidence"] * min(
                1.0, 0.55 + proposal["prominence"] / max(1.0, height * 0.06)
            )
            event = {
                "event_type": "candidate_bounce",
                "track_id": track["id"],
                "video_time_ms": round(sample["time_ms"], 1),
                "image_point": {"x_px": sample["x_px"], "y_px": sample["y_px"]},
                "estimated_court_point": None,
                "distance_to_line_m": None,
                "sigma_m": None,
                "nearest_line": None,
                "line_call": "UNCERTAIN",
                "confidence": round(float(confidence), 3),
                "quality_flags": flags,
                "evidence_time_ms": [
                    round(max(0.0, sample["time_ms"] - 320)),
                    round(max(0.0, sample["time_ms"] - 140)),
                    round(sample["time_ms"]),
                    round(min(duration_ms, sample["time_ms"] + 180)),
                ],
            }

            if homography is not None and inverse is not None and calibration_error is not None:
                projected = project(homography, (sample["x_px"], sample["y_px"]))
                if projected is None or abs(projected[0]) > 40 or abs(projected[1]) > 60:
                    flags.append("projected_far_outside_court")
                else:
                    detection_noise = max(calibration_error, 2.5) + (1 - confidence) * 24 + 4
                    geometric = propagate_uncertainty(
                        inverse, (sample["x_px"], sample["y_px"]), detection_noise
                    )
                    sigma = math.sqrt(min(geometric, 4.0) ** 2 + HEIGHT_UNCERTAINTY_M**2)
                    decision = evaluate_bounce(projected, sigma, args.format)
                    event["estimated_court_point"] = {"x": round(projected[0], 3), "y": round(projected[1], 3)}
                    event["sigma_m"] = round(sigma, 3)
                    event["distance_to_line_m"] = round(decision["distance_to_line_m"], 3)
                    event["nearest_line"] = decision["nearest_line"]
                    event["line_call"] = decision["line_call"]
                    event["reason"] = decision["reason"]
                    if sigma > 0.5:
                        flags.append("bounce_location_uncertain")
                    if decision["line_call"] == "UNCERTAIN":
                        flags.append("line_call_abstained")

            if confidence < 0.55:
                flags.append("possible_motion_blur")
            if len(track["samples"]) < 5:
                flags.append("short_track")
            edge_x = min(sample["x_px"], width - sample["x_px"]) < width * 0.04
            edge_y = min(sample["y_px"], height - sample["y_px"]) < height * 0.04
            if edge_x or edge_y:
                flags.append("near_frame_edge")

            event["quality_flags"] = sorted(set(flags))
            events.append(event)

    if not tracks:
        warnings.append(
            "No ball-sized detections were found. The colour baseline needs a visible yellow-green ball."
        )

    out_dir = Path(args.out).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = source.stem

    report = {
        "video": {
            "path": str(source),
            "width": width,
            "height": height,
            "fps": round(float(fps), 3),
            "frames_processed": processed,
            "duration_ms": round(duration_ms, 1),
        },
        "checks": {
            "mean_luma": round(mean_luma, 2),
            "laplacian_variance": round(mean_blur, 2),
            "warnings": warnings,
        },
        "calibration": {
            "used": homography is not None,
            "points": len(keypoints),
            "reprojection_error_px": round(calibration_error, 3)
            if calibration_error is not None
            else None,
        },
        "detector": "hsv-colour baseline (experimental)",
        "court_format": args.format,
        "tracks": tracks,
        "bounce_events": events,
        "summary": {
            "frames_with_ball": sum(1 for entry in per_frame if entry["detection"]),
            "coverage": round(
                sum(1 for entry in per_frame if entry["detection"]) / max(1, processed), 4
            ),
            "bounce_candidates": len(events),
            "uncertain_calls": sum(1 for event in events if event["line_call"] == "UNCERTAIN"),
        },
        "warnings": warnings,
    }

    json_path = out_dir / f"{stem}-analysis.json"
    json_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    if not args.no_video:
        capture = cv2.VideoCapture(str(source))
        video_path = out_dir / f"{stem}-annotated.mp4"
        writer = cv2.VideoWriter(
            str(video_path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height)
        )
        events_by_frame: dict[int, list[dict]] = {}
        for event in events:
            index = int(round(event["video_time_ms"] * fps / 1000.0))
            events_by_frame.setdefault(index, []).append(event)

        rendered = 0
        while rendered < processed:
            ok, frame = capture.read()
            if not ok:
                break
            if inverse is not None:
                draw_court(frame, inverse)
            detection = per_frame[rendered]["detection"]
            if detection:
                x = int(round(detection["x_px"]))
                y = int(round(detection["y_px"]))
                cv2.circle(frame, (x, y), 14, (61, 255, 198), 2, cv2.LINE_AA)
                cv2.putText(
                    frame,
                    f"{detection['confidence']:.2f}",
                    (x + 16, y - 10),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.45,
                    (61, 255, 198),
                    1,
                    cv2.LINE_AA,
                )
            for event in events_by_frame.get(rendered, []):
                draw_event(frame, event)
            cv2.putText(
                frame,
                "CourtVision CV PoC - experimental, not an official line call",
                (16, height - 20),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.55,
                (200, 255, 210),
                1,
                cv2.LINE_AA,
            )
            writer.write(frame)
            rendered += 1

        writer.release()
        capture.release()
        print(f"Annotated video: {video_path}")

    print(f"Analysis JSON:   {json_path}")
    print(
        f"Frames: {processed} · tracks: {len(tracks)} · bounce candidates: {len(events)} · "
        f"UNCERTAIN: {report['summary']['uncertain_calls']}"
    )
    for warning in warnings:
        print(f"  ! {warning}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="CourtVision computer-vision proof of concept (experimental line-call estimates)."
    )
    parser.add_argument("clip", nargs="?", help="Path to the input video clip")
    parser.add_argument("--keypoints", help="JSON file with court keypoint pixel coordinates")
    parser.add_argument("--out", default="output", help="Output directory (default: output)")
    parser.add_argument(
        "--format", default="singles", choices=["singles", "doubles"], help="Court format for IN/OUT"
    )
    parser.add_argument("--max-frames", type=int, default=0, help="Cap processed frames")
    parser.add_argument("--no-video", action="store_true", help="Skip the annotated MP4")
    parser.add_argument(
        "--print-template", action="store_true", help="Print a keypoint JSON template and exit"
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.print_template:
        print_template()
        return 0
    if not args.clip:
        parser.error("a clip path is required (or use --print-template)")
    return analyse(args)


if __name__ == "__main__":
    raise SystemExit(main())

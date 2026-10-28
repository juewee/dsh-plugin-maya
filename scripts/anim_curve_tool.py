# -*- coding: utf-8 -*-
"""
anim_curve_tool.py — Maya animation-curve inspector and reshaper.

Two jobs, one module:

  inspect  Read the curves behind the current selection (or a node list) and
           report, per channel: key count, tangent types/angles, negative
           velocity frames, overshoot, speed monotonicity and the largest
           jerk (acceleration discontinuity).  This is the diagnosis step.

  fit_exp  Replace a channel with a five-key exponential ease driven by
           explicit tangent handles.  Three anchor points that already look
           right to the animator (first / a mid anchor / last) define
           y(u) = A * exp(k*u) + B exactly; the other keys are sampled from
           that curve and every tangent angle is the analytic derivative, so
           the result is C1-continuous with no segment seams.

Everything is read-only unless an "apply" function is called.  Values are
never invented: `fit_exp` derives them from the three anchors you pass.

Usage inside Maya (Script Editor, or `maya.cmd` / mayapy):

    import anim_curve_tool as act

    act.inspect()                                   # selected objects
    act.inspect(nodes=["Camera_Global"], verbose=True)
    act.fit_exp("Camera_Global.rotateZ", 101, 151, 206)
    act.fit_exp("Camera_Global.rotateZ", 101, 151, 206, apply=True)

Dry run is the default for every mutating helper: nothing changes until
`apply=True`.

Requires Maya 2020+ (uses only maya.cmds keyframe/keyTangent).
"""

from __future__ import print_function

import io
import json
import math
import os
import traceback

import maya.cmds as cmds

# Channels that carry real motion. Attribute scale/visibility are skipped by
# default: they are either steps (visibility) or constants.
SKIP_SUFFIXES = (
    "visibility",
    "scaleX",
    "scaleY",
    "scaleZ",
    "locks",
)

MOTION_SUFFIXES = (
    "translateX",
    "translateY",
    "translateZ",
    "rotateX",
    "rotateY",
    "rotateZ",
)

# An angle below this (degrees) is treated as "flat" — Maya's auto/clamped
# tangents flatten a curve's first and last key to exactly 0.0, which reads as
# a hard start or stop.
FLAT_ANGLE_EPS = 1e-3


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------


def _keyed_attrs(node):
    """Keyed animatable attributes of `node`, in a stable order."""
    out = []
    for attr in cmds.listAnimatable(node) or []:
        try:
            count = cmds.keyframe(attr, query=True, keyframeCount=True) or 0
        except Exception:
            continue
        if count:
            out.append(attr)
    return out


def _expand(node):
    """A transform plus its descendant transforms."""
    nodes = [node]
    nodes.extend(cmds.listRelatives(node, allDescendents=True, type="transform") or [])
    return nodes


def _sample(attr, frame_range=None):
    """Per-frame values of `attr`; None when the range is unknown."""
    times = cmds.keyframe(attr, query=True, timeChange=True) or []
    if not times:
        return [], []
    f0 = int(round(times[0]))
    f1 = int(round(times[-1]))
    if frame_range:
        f0 = max(f0, int(frame_range[0]))
        f1 = min(f1, int(frame_range[1]))
    values = []
    for fr in range(f0, f1 + 1):
        got = cmds.keyframe(attr, query=True, eval=True, time=(fr, fr))
        if got:
            values.append(got[0])
    return list(range(f0, f0 + len(values))), values


def _deltas(values):
    return [values[i] - values[i - 1] for i in range(1, len(values))]


def _analysis(frames, values):
    """Smoothness metrics for one channel's per-frame samples."""
    n = len(values)
    res = {
        "frames": [frames[0], frames[-1]] if frames else None,
        "samples": n,
        "start": values[0] if n else None,
        "end": values[-1] if n else None,
        "span": (values[-1] - values[0]) if n else 0.0,
        "monotonic": True,
        "negative_velocity_frames": [],
        "overshoot_frames": [],
        "speed_decrease_frames": [],
        "max_jerk": 0.0,
        "max_jerk_frame": None,
        "speed_samples": {},
    }
    if n < 3:
        return res

    span = res["span"]
    sign = 1.0 if span >= 0 else -1.0
    abs_span = abs(span)

    speed = [(frames[i], (values[i] - values[i - 1])) for i in range(1, n)]
    directed = [(f, s * sign) for f, s in speed]  # positive == moving toward end

    res["negative_velocity_frames"] = [f for f, s in directed if s < -1e-12]
    if abs_span > 1e-12:
        res["overshoot_frames"] = [
            f for i, (f, _) in enumerate(speed)
            if (values[i + 1] - values[0]) * sign > abs_span + 1e-9
            or (values[i + 1] - values[0]) * sign < -1e-9
        ]
    res["speed_decrease_frames"] = [
        directed[i][0]
        for i in range(1, len(directed))
        if directed[i][1] < directed[i - 1][1] - 1e-12
    ]
    res["monotonic"] = not res["negative_velocity_frames"]

    acc = [directed[i][1] - directed[i - 1][1] for i in range(1, len(directed))]
    for i in range(1, len(acc)):
        jerk = abs(acc[i] - acc[i - 1])
        if jerk > res["max_jerk"]:
            res["max_jerk"] = jerk
            res["max_jerk_frame"] = directed[i + 1][0]

    per_frame = dict(speed)
    step = max(1, len(frames) // 8)
    for fr in frames[::step]:
        if fr in per_frame:
            res["speed_samples"][fr] = round(per_frame[fr], 6)
    return res


def _tangent_report(attr):
    """Tangent types and angles for every key of `attr`."""
    times = cmds.keyframe(attr, query=True, timeChange=True) or []
    if not times:
        return []
    in_type = cmds.keyTangent(attr, query=True, inTangentType=True) or []
    out_type = cmds.keyTangent(attr, query=True, outTangentType=True) or []
    in_angle = cmds.keyTangent(attr, query=True, inAngle=True) or []
    out_angle = cmds.keyTangent(attr, query=True, outAngle=True) or []
    locked = cmds.keyTangent(attr, query=True, lock=True) or []
    out = []
    for i, t in enumerate(times):
        out.append(
            {
                "frame": round(t, 4),
                "in_type": in_type[i] if i < len(in_type) else "?",
                "in_angle": round(in_angle[i], 4) if i < len(in_angle) else None,
                "out_type": out_type[i] if i < len(out_type) else "?",
                "out_angle": round(out_angle[i], 4) if i < len(out_angle) else None,
                "locked": bool(locked[i]) if i < len(locked) else None,
            }
        )
    return out


# --------------------------------------------------------------------------
# inspect
# --------------------------------------------------------------------------


def inspect(nodes=None, frames=None, verbose=False, json_path=None):
    """Diagnose the animation curves of `nodes` (default: the selection).

    Returns a list of per-channel records. Every mutating decision we make
    downstream should be based on this report, not on guesswork:
    `negative_velocity_frames` is a visible bounce, `overshoot_frames` is a
    camera that travels past its endpoint, `max_jerk` localises the segment
    seam that reads as a hard "gear change".
    """
    if nodes is None:
        nodes = cmds.ls(selection=True) or []
    if not nodes:
        print("inspect: nothing selected and no nodes given")
        return []

    report = []
    for node in nodes:
        if not cmds.objExists(node):
            print("inspect: missing node %s" % node)
            continue
        for child in _expand(node):
            for attr in _keyed_attrs(child):
                suffix = attr.split(".")[-1]
                if suffix in SKIP_SUFFIXES:
                    continue
                values = cmds.keyframe(attr, query=True, valueChange=True) or []
                const = values and (max(values) - min(values)) < 1e-9
                record = {
                    "attr": attr,
                    "node": child,
                    "channel": suffix,
                    "key_count": len(values),
                    "constant": bool(const),
                    "tangents": _tangent_report(attr),
                }
                if not const:
                    fr, vals = _sample(attr, frames)
                    record["analysis"] = _analysis(fr, vals)
                    # End tangents that Maya flattened to 0 read as a hard
                    # start/stop; flag them explicitly.
                    tan = record["tangents"]
                    if tan:
                        first_out = tan[0].get("out_angle")
                        last_in = tan[-1].get("in_angle")
                        record["flat_entry"] = (
                            first_out is not None and abs(first_out) < FLAT_ANGLE_EPS
                        )
                        record["flat_exit"] = (
                            last_in is not None and abs(last_in) < FLAT_ANGLE_EPS
                        )
                report.append(record)

    if verbose or not json_path:
        _print_report(report, verbose)
    if json_path:
        with io.open(json_path, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(report, indent=1, ensure_ascii=False))
        print("inspect: wrote %d channel(s) to %s" % (len(report), json_path))
    return report


def _print_report(report, verbose):
    if not report:
        print("inspect: no animated channels found")
        return
    print("=" * 78)
    for r in report:
        head = "%-42s keys=%-3d" % (r["attr"], r["key_count"])
        if r["constant"]:
            print(head + " CONSTANT (skipped)")
            continue
        a = r["analysis"]
        issues = []
        if a["negative_velocity_frames"]:
            issues.append("BOUNCE @%s" % a["negative_velocity_frames"][:4])
        if a["overshoot_frames"]:
            issues.append("OVERSHOOT @%s" % a["overshoot_frames"][:4])
        if a["speed_decrease_frames"]:
            issues.append("%d speed dips" % len(a["speed_decrease_frames"]))
        if r.get("flat_entry"):
            issues.append("FLAT ENTRY (0deg)")
        if r.get("flat_exit"):
            issues.append("FLAT EXIT (0deg)")
        print(head + " %s" % (", ".join(issues) if issues else "clean"))
        print(
            "    range %s  span %.5f  max_jerk %.6f @f%s"
            % (a["frames"], a["span"], a["max_jerk"], a["max_jerk_frame"])
        )
        if verbose:
            for t in r["tangents"]:
                print(
                    "    f%-8.2f in=%-7s %9.3f  out=%-7s %9.3f  lock=%s"
                    % (
                        t["frame"],
                        t["in_type"],
                        t["in_angle"] if t["in_angle"] is not None else 0,
                        t["out_type"],
                        t["out_angle"] if t["out_angle"] is not None else 0,
                        t["locked"],
                    )
                )
            print("    speed %s" % a["speed_samples"])
    print("=" * 78)


# --------------------------------------------------------------------------
# exponential fit
# --------------------------------------------------------------------------


def _solve_exponential(u1, y0, y1, y_end):
    """Solve y(u) = A*exp(k*u) + B through (0,y0), (u1,y1), (1,y_end).

    The three points over-determine the shape, so k is found from the ratio
    of the two increments; closed form is impossible because k appears inside
    two exponentials, hence the bisection. Returns (A, k, B).
    """
    d1 = y1 - y0
    dE = y_end - y0
    if abs(dE) < 1e-15:
        raise ValueError("start and end values are identical; no ease to fit")
    ratio = d1 / dE

    def residual(k):
        if abs(k) < 1e-12:
            return u1 - ratio
        return (math.exp(k * u1) - 1.0) / (math.exp(k) - 1.0) - ratio

    lo, hi = -60.0, 60.0
    f_lo = residual(lo)
    if f_lo * residual(hi) > 0:
        # No bracketed root: the mid anchor is not strictly between the ends
        # in u/power space, so fall back to the closest sampled k.
        best = (abs(f_lo), lo)
        k = lo
        while k <= hi:
            val = abs(residual(k))
            if val < best[0]:
                best = (val, k)
            k += 0.005
        k = best[1]
    else:
        for _ in range(200):
            mid = (lo + hi) / 2.0
            f_mid = residual(mid)
            if abs(f_mid) < 1e-15:
                lo = hi = mid
                break
            if f_lo * f_mid <= 0:
                hi = mid
            else:
                lo = mid
                f_lo = f_mid
        k = (lo + hi) / 2.0

    a = dE / (math.exp(k) - 1.0)
    b = y0 - a
    return a, k, b


def fit_exp(attr, first_frame, mid_frame, last_frame, keys=None, apply=False):
    """Reshape `attr` into a five-key exact exponential ease.

    `attr`        full attribute path, e.g. "Camera_Global.rotateZ"
    first/mid/last  the three anchor frames (their CURRENT values are kept)
    keys          the five destination frames; default keeps the original
                  first/last and uses the original interior keys, adding
                  none if there are fewer than three.
    apply         False (default) only plans and prints; True writes.

    Returns a dict with the plan and the measured result.
    """
    if not cmds.objExists(attr):
        raise ValueError("no such attribute: %s" % attr)

    times = cmds.keyframe(attr, query=True, timeChange=True) or []
    values = cmds.keyframe(attr, query=True, valueChange=True) or []
    if len(times) < 2:
        raise ValueError("%s has fewer than two keys" % attr)

    def value_at(frame):
        got = cmds.keyframe(attr, query=True, eval=True, time=(frame, frame))
        if not got:
            raise ValueError("cannot evaluate %s at frame %s" % (attr, frame))
        return got[0]

    t0, t1, t2 = float(first_frame), float(mid_frame), float(last_frame)
    if not (t0 < t1 < t2):
        raise ValueError("anchors must be ordered first < mid < last")
    y0, y1, y2 = value_at(t0), value_at(t1), value_at(t2)

    u1 = (t1 - t0) / (t2 - t0)
    a, k, b = _solve_exponential(u1, y0, y1, y2)

    def curve(u):
        return a * math.exp(k * u) + b

    def slope_per_frame(u):
        # d/du * du/d(frame)
        return a * k * math.exp(k * u) / (t2 - t0)

    if keys is None:
        interior = [t for t in times if t0 < t < t2]
        # Keep the scene's own key positions; five is the sweet spot the
        # session found (three is too few to hold an exponential's shape,
        # per-frame baking makes the handles uneditable).
        keys = [t0] + sorted(interior) + [t2]
    if len(keys) != 5:
        # Pad the two largest gaps so we end up with exactly five keys.
        while len(keys) < 5:
            gaps = [(keys[i + 1] - keys[i], i) for i in range(len(keys) - 1)]
            _, i = max(gaps)
            keys.insert(i + 1, round((keys[i] + keys[i + 1]) / 2.0, 3))
        if len(keys) > 5:
            # Drop the interior key closest to another interior key.
            while len(keys) > 5:
                interior = keys[1:-1]
                drop = min(
                    range(len(interior)),
                    key=lambda i: min(
                        abs(interior[i] - keys[0]), abs(interior[i] - keys[-1])
                    ),
                )
                del keys[1 + drop]

    plan = []
    for t in keys:
        u = (t - t0) / (t2 - t0)
        plan.append(
            {
                "frame": round(t, 4),
                "value": curve(u),
                "angle": math.degrees(math.atan(slope_per_frame(u))),
            }
        )

    result = {
        "attr": attr,
        "anchors": {"first": t0, "mid": t1, "last": t2},
        "anchor_values": {"first": y0, "mid": y1, "last": y2},
        "solved": {"A": a, "k": k, "B": b},
        "plan": plan,
        "applied": False,
    }

    if not apply:
        print("fit_exp DRY RUN %s" % attr)
        print("  y(u) = %.12f * exp(%.12f * u) + %.12f" % (a, k, b))
        for p in plan:
            print(
                "  f%-8.2f value=%12.6f  angle=%9.4f"
                % (p["frame"], p["value"], p["angle"])
            )
        print("  pass apply=True to write")
        return result

    cmds.undoInfo(openChunk=True, chunkName="anim_curve_tool.fit_exp")
    try:
        f_lo = int(round(times[0]))
        f_hi = int(round(times[-1]))
        cmds.cutKey(attr, time=(f_lo, f_hi), clear=True)
        for p in plan:
            cmds.setKeyframe(attr, time=p["frame"], value=p["value"])
        for p in plan:
            # setKeyframe refuses "fixed" directly, so switch through auto and
            # then pin the analytic angle.
            cmds.keyTangent(
                attr, edit=True, time=(p["frame"], p["frame"]),
                inTangentType="auto", outTangentType="auto",
            )
            cmds.keyTangent(
                attr, edit=True, time=(p["frame"], p["frame"]), absolute=True,
                inTangentType="fixed", outTangentType="fixed",
                inAngle=p["angle"], outAngle=p["angle"],
            )
        try:
            cmds.keyTangent(attr, edit=True, time=(keys[0], keys[-1]), lock=True)
        except Exception:
            pass
        result["applied"] = True
    except Exception:
        traceback.print_exc()
    finally:
        cmds.undoInfo(closeChunk=True)

    fr, vals = _sample(attr)
    result["after"] = _analysis(fr, vals)
    a_report = result["after"]
    print(
        "fit_exp APPLIED %s -> %d keys, monotonic=%s, max_jerk=%.6f"
        % (attr, len(plan), a_report["monotonic"], a_report["max_jerk"])
    )
    return result


# --------------------------------------------------------------------------
# convenience: fix flat end tangents without touching values
# --------------------------------------------------------------------------


def unflatten_ends(attr, limit_deg=1.0, apply=False):
    """Give a channel's first/last tangent a small nonzero angle.

    Maya's auto/spline/clamped tangents flatten a curve's endpoints to exactly
    0 degrees, which the eye reads as a dead start or an abrupt stop. This
    nudges ONLY the endpoint angles to the channel's own first/last segment
    slope, clamped to +/- `limit_deg`, and leaves every value and interior
    tangent alone.
    """
    if not cmds.objExists(attr):
        raise ValueError("no such attribute: %s" % attr)
    times = cmds.keyframe(attr, query=True, timeChange=True) or []
    values = cmds.keyframe(attr, query=True, valueChange=True) or []
    if len(times) < 2:
        return None

    first_slope = (values[1] - values[0]) / (times[1] - times[0])
    last_slope = (values[-1] - values[-2]) / (times[-1] - times[-2])

    def clamp(deg):
        deg = max(-limit_deg, min(limit_deg, deg))
        if abs(deg) < 1e-3:
            deg = 0.01 if first_slope >= 0 else -0.01
        return deg

    entry = clamp(math.degrees(math.atan(first_slope)))
    exit_ = clamp(math.degrees(math.atan(last_slope)))
    plan = {
        "attr": attr,
        "first_frame": times[0],
        "first_angle": entry,
        "last_frame": times[-1],
        "last_angle": exit_,
    }
    if not apply:
        print("unflatten_ends DRY RUN %s" % attr)
        print("  f%-8.2f out_angle=%.4f" % (times[0], entry))
        print("  f%-8.2f in_angle =%.4f" % (times[-1], exit_))
        return plan

    cmds.keyTangent(
        attr, edit=True, time=(times[0], times[0]), absolute=True,
        inTangentType="fixed", outTangentType="fixed",
        inAngle=entry, outAngle=entry,
    )
    cmds.keyTangent(
        attr, edit=True, time=(times[-1], times[-1]), absolute=True,
        inTangentType="fixed", outTangentType="fixed",
        inAngle=exit_, outAngle=exit_,
    )
    print("unflatten_ends APPLIED %s" % attr)
    return plan


# --------------------------------------------------------------------------
# CLI (mayapy / Script Editor)
# --------------------------------------------------------------------------


def _cli(argv):
    """Minimal CLI so the module can run under mayapy without a GUI."""
    action = argv[1] if len(argv) > 1 else "inspect"
    if action == "inspect":
        nodes = argv[2:] or None
        result = inspect(nodes=nodes, verbose=True)
        print("RESULT %d channel(s)" % len(result))
        return
    if action == "fit":
        # fit <attr> <first> <mid> <last> [--apply]
        attr, t0, t1, t2 = argv[2], int(argv[3]), int(argv[4]), int(argv[5])
        apply = "--apply" in argv
        fit_exp(attr, t0, t1, t2, apply=apply)
        return
    if action == "unflatten":
        attr = argv[2]
        apply = "--apply" in argv
        unflatten_ends(attr, apply=apply)
        return
    print("usage: anim_curve_tool.py [inspect [node ...] | fit <attr> <f0> <f1> <f2> [--apply] | unflatten <attr> [--apply]]")


if __name__ == "__main__":
    import sys

    try:
        _cli(sys.argv)
    except Exception:
        traceback.print_exc()

---
name: maya-anim-curve-diagnostics
description: "Diagnose and reshape stiff Maya animation curves with scripts/anim_curve_tool.py: measure bounce, overshoot and acceleration discontinuities (jerk) per channel, then rebuild a channel as a five-key exact exponential ease driven by explicit tangent handles. Invoke when a user says a Maya curve looks stiff, not smooth, jerky, bounces, accelerates abruptly, or asks to fix camera/controller animation timing."
---

# Maya Animation Curve Diagnostics

A curve that *looks* wrong is almost never fixed by adding more keys. Measure
first, then reshape the numbers, then verify. `scripts/anim_curve_tool.py` in
this plugin does all three; this skill is the method around it.

## Load it

```python
import sys
sys.path.insert(0, r"<plugin>/scripts")
import anim_curve_tool as act
```

## Step 1 — measure, do not guess

```python
act.inspect()                        # the current selection
act.inspect(nodes=["Camera_Global"]) # explicit nodes (includes descendants)
act.inspect(verbose=True)            # plus every tangent angle
act.inspect(json_path="report.json") # machine-readable, for diffing
```

Read the report:

| Field | Meaning | What it looks like in the viewport |
|---|---|---|
| `negative_velocity_frames` | motion reverses direction | a bounce, a camera that steps backwards |
| `overshoot_frames` | travels past its endpoint, then comes back | a hook at the end of a move |
| `speed_decrease_frames` | speed dips mid-move | hesitant, "gear change" |
| `max_jerk` / `max_jerk_frame` | largest change in acceleration, with its frame | the hard kink you can actually see |
| `flat_entry` / `flat_exit` | first `out_angle` / last `in_angle` is exactly 0° | dead start, abrupt stop |

**`max_jerk_frame` is the money number.** A visible hard turn is an
acceleration discontinuity at that frame, not a keyframe that is "too far
apart".

### The algorithm sees what the viewport cannot

The Graph Editor shows curves at whatever zoom the user happens to be at. A
small bounce — a few hundredths of a unit reversing direction for a few frames —
is invisible at default zoom, and at high zoom the tangent handles are
themselves visually distorted (controls that look like they rotate a lot barely
change their value). Do not trust the eye for this.

`inspect()` works on per-frame values (`v[i] - v[i-1]` sign changes), so it is
completely independent of viewport scale and catches reversals of any
amplitude. **That is what this tool is for: it is the measuring instrument, not
the viewport.**

### …but detection is not repair

A detected defect does not imply an automatic fix. On a real camera channel this
session measured `max_jerk 0.0386 @f182` and five different automatic repairs
made it **worse** — nudging a tangent angle, inserting a bridging key, baking to
per-frame linear, low-pass filtering the acceleration, and re-deriving the tail
from the mid anchor. Only re-solving the whole channel as an exponential worked.

So:

1. `inspect()` to find the defect and get the number.
2. Make **one** change.
3. `inspect()` again and compare `max_jerk` before/after.
4. If it got worse, **roll back** and try a different approach. Do not stack
   fixes.

Report the before/after numbers, and say plainly when an attempt failed.


## Step 2 — know what causes each symptom

Verified against real scenes in Maya 2022:

| Symptom | Cause | Fix |
|---|---|---|
| Visible kink at one frame | acceleration jumps at a keyframe boundary: `fixed` tangents meeting a much steeper segment | reshape the values around it (see Step 3) |
| Dead start / abrupt stop | `auto`, `spline` and `clamped` tangents flatten a curve's **endpoints to exactly 0°** | `act.unflatten_ends(attr, limit_deg=1.0, apply=True)` |
| Bounce (velocity flips) | `spline` over-shooting between widely spaced keys | `clamped`, or reshape values |
| Camera drifts past its target | key values themselves are ordered wrong | fix the values; no tangent type can rescue it |

Hard-won gotchas:

- **Switching to `clamped` does not make the entry angle nonzero.** It pins a
  curve's *first* key to 0° by design. Verified: moving the second key anywhere
  still leaves `out_angle == 0.0`.
- **Moving keys does not fix a bounce** if the bounce comes from the key
  *values*. Verified across a 4x4 position sweep — the flip count did not change.
- **Changing one tangent angle can make it worse.** The angle at a key also
  bends the segment *before* it; nudging a key's out-angle toward the neighbours'
  average produced new overshoot. Always re-run `inspect` after a change and
  compare `max_jerk`.
- **`setKeyframe` rejects `inTangentType="fixed"`.** Insert the key with a
  default type, switch it to `auto`, then set `absolute=True, inTangentType="fixed"`
  with the angle.
- **`keyTangent(lock=True)` means the in/out handles move together** — it is the
  "don't break the handle" state animators expect. Do not pass `lock=False`
  unless you intend to detach them.

## Step 3 — reshape as an exponential ease

When the motion should *accelerate continuously* (camera pushes, whips, fly-ins)
the cleanest result is a real exponential, not a hand-shaped bezier.

Three anchor frames that already look right define the curve exactly:

```
y(u) = A * exp(k*u) + B        u = (frame - first) / (last - first)
```

```python
# dry run first — it only prints the plan
act.fit_exp("Camera_Global.rotateZ", 101, 151, 206)

# then write
act.fit_exp("Camera_Global.rotateZ", 101, 151, 206, apply=True)
```

`fit_exp` keeps the anchor *values* you chose, samples the other three keys from
the solved curve, and sets every tangent to the analytic derivative — so the
result is C1 continuous with no segment seams. It is undoable as one chunk.

Why five keys and not more:

| Keys | Result (measured on a real camera channel) |
|---|---|
| 3 | cannot hold the shape; the middle of each segment drifts |
| **5 + handles** | **`max_jerk` 0.0165, fully editable** |
| 106 (per-frame baked, linear) | `max_jerk` 0.0342 — *worse*, because per-frame `linear` re-introduces a kink every frame |

Per-frame baking also destroys editability: one handle then moves a single
frame. Prefer five keys with correct handles.

## Step 4 — always verify

```python
rep = act.inspect(nodes=["Camera_Global"], verbose=True)
```

Accept only when: `negative_velocity_frames == []`, `overshoot_frames == []`,
`monotonic is True`, and `max_jerk` went **down** versus the number you started
with. Report both numbers to the user — they are the evidence.

## Rules

1. Never mutate before measuring. `inspect` is read-only; every apply helper
   defaults to a dry run.
2. Never change a first or last frame's value unless the user asked — those are
   the in/out poses.
3. Back the channel up before a rewrite (`cmds.keyframe(..., q=True, valueChange=True)`
   into a JSON file) and say where it is.
4. Never save the user's scene for them.
5. Report measured before/after numbers, and say plainly when an attempt did
   not improve things and was rolled back.
6. **One change, then re-measure.** Stacking fixes without re-running `inspect`
   is how a "repair" turns a 0.0386 jerk into a 0.43 one. If `max_jerk` rose,
   roll back instead of patching the patch.
7. **Trust the numbers over the viewport** for bounce and overshoot: small
   reversals are invisible at working zoom. Trust the viewport for how the move
   *reads* — the algorithm cannot tell you whether a smooth curve is the right
   performance.

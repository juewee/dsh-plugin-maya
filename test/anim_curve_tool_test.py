# -*- coding: utf-8 -*-
"""End-to-end test of scripts/anim_curve_tool.py under real mayapy."""
import sys, os, math

sys.path.insert(0, r"C:/Users/TheFl/Desktop/losheep/code/DSH/dsh-plugin-maya/scripts")

import maya.standalone
maya.standalone.initialize(name="python")

import maya.cmds as cmds
import anim_curve_tool as act

fail = []


def check(label, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + label + ("  " + detail if detail else ""))
    if not cond:
        fail.append(label)


try:
    # --- build a stiff curve: 5 keys, all auto, big acceleration step at 181
    cmds.polyCube(name="Ctrl")
    cmds.setKeyframe("Ctrl.translateX", time=101, value=0.0)
    cmds.setKeyframe("Ctrl.translateX", time=124, value=-0.06)
    cmds.setKeyframe("Ctrl.translateX", time=151, value=-0.61)
    cmds.setKeyframe("Ctrl.translateX", time=181, value=-10.0)
    cmds.setKeyframe("Ctrl.translateX", time=206, value=-64.57)

    print("\n--- inspect ---")
    rep = act.inspect(nodes=["Ctrl"], verbose=False)
    check("inspect returned channels", len(rep) >= 1, "n=%d" % len(rep))
    rec = [r for r in rep if r["channel"] == "translateX"][0]
    check("record has analysis", "analysis" in rec)
    check("key count reported", rec["key_count"] == 5, str(rec["key_count"]))
    check("flat_entry flagged or clean", "flat_entry" in rec, str(rec.get("flat_entry")))
    print("  analysis max_jerk=%.6f" % rec["analysis"]["max_jerk"])

    # --- dry run must not touch the scene
    before = cmds.keyframe("Ctrl.translateX", q=True, valueChange=True)
    plan = act.fit_exp("Ctrl.translateX", 101, 151, 206, apply=False)
    after = cmds.keyframe("Ctrl.translateX", q=True, valueChange=True)
    check("dry run leaves values alone", before == after)
    check("dry run returns 5 keys planned", len(plan["plan"]) == 5, str(len(plan["plan"])))
    check("anchors preserved", abs(plan["anchor_values"]["first"] - 0.0) < 1e-9)
    check(
        "mid anchor preserved",
        abs(plan["anchor_values"]["mid"] - (-0.61)) < 1e-6,
    )

    # --- apply
    res = act.fit_exp("Ctrl.translateX", 101, 151, 206, apply=True)
    check("apply reported applied", res["applied"] is True)
    kt = cmds.keyframe("Ctrl.translateX", q=True, timeChange=True)
    kv = cmds.keyframe("Ctrl.translateX", q=True, valueChange=True)
    check("5 keys written", len(kt) == 5, str(len(kt)))
    check("first value kept", abs(kv[0] - 0.0) < 1e-9, str(kv[0]))
    check("last value kept", abs(kv[-1] - (-64.57)) < 1e-6, str(kv[-1]))
    tan = cmds.keyTangent("Ctrl.translateX", q=True, inTangentType=True)
    check("tangents are fixed", set(tan) == {"fixed"}, str(set(tan)))

    aft = res["after"]
    check("result monotonic", aft["monotonic"], str(aft["negative_velocity_frames"][:3]))
    check("no overshoot", not aft["overshoot_frames"], str(aft["overshoot_frames"][:3]))
    check("jerk improved vs original", aft["max_jerk"] < rec["analysis"]["max_jerk"],
          "old=%.6f new=%.6f" % (rec["analysis"]["max_jerk"], aft["max_jerk"]))

    # --- unflatten_ends
    print("\n--- unflatten_ends ---")
    cmds.setKeyframe("Ctrl.translateY", time=101, value=0.0)
    cmds.setKeyframe("Ctrl.translateY", time=206, value=5.0)
    act.unflatten_ends("Ctrl.translateY", apply=True)
    oa = cmds.keyTangent("Ctrl.translateY", q=True, outAngle=True)[0]
    ia = cmds.keyTangent("Ctrl.translateY", q=True, inAngle=True)[-1]
    check("entry angle nonzero", abs(oa) > 1e-3, "%.5f" % oa)
    check("exit angle nonzero", abs(ia) > 1e-3, "%.5f" % ia)
    check("entry within limit", abs(oa) <= 1.0, "%.5f" % oa)

    # --- error handling
    print("\n--- error handling ---")
    try:
        act.fit_exp("NoSuchNode.rotateZ", 1, 2, 3)
        check("missing attr raises", False)
    except ValueError as e:
        check("missing attr raises", True, str(e)[:40])

    try:
        act.fit_exp("Ctrl.translateX", 206, 151, 101)
        check("unordered anchors raise", False)
    except ValueError:
        check("unordered anchors raise", True)

except Exception:
    import traceback
    traceback.print_exc()
    fail.append("EXCEPTION")
finally:
    try:
        maya.standalone.uninitialize()
    except Exception:
        pass

print("")
print("FAILURES: %d" % len(fail))
if fail:
    print("FAILED:", fail)
print("TEST_DONE")

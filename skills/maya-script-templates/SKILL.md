---
name: maya-script-templates
description: "Copy-ready Maya Python (maya.cmds) patterns for common automation tasks: creating and transforming objects, scene queries, polygon modeling, keyframes, file import/export, custom attributes, shading, deformers, UI windows and batch processing. Invoke when writing or scaffolding Maya scripts and you need a proven starting point instead of inventing API calls."
---

# Maya Script Templates

Patterns that compile. Every snippet assumes `import maya.cmds as cmds`. Verify the specific command you depend on with `maya_doc_get` before shipping, and test the whole script with `maya_standalone`.

## Skeleton

```python
# -*- coding: utf-8 -*-
"""Script: <name> — <what it does>. Usage: run in the Script Editor or via mayapy."""
import maya.cmds as cmds
import maya.mel as mel


def main():
    pass


if __name__ == "__main__":
    main()
```

## Headless (mayapy) skeleton

```python
# -*- coding: utf-8 -*-
import maya.standalone
maya.standalone.initialize(name="python")

import maya.cmds as cmds
import os


def main():
    cmds.polyCube(name="MyCube")
    sphere = cmds.polySphere(name="MySphere")[0]
    cmds.move(5, 0, 0, sphere)

    out = os.path.join(os.environ["USERPROFILE"], "Desktop", "output.ma")
    cmds.file(rename=out)
    cmds.file(save=True, type="mayaAscii")
    print("SAVED", out)


if __name__ == "__main__":
    main()
    maya.standalone.uninitialize()
```

## 1. Create and transform

```python
cube = cmds.polyCube(name="MyCube")[0]
sphere = cmds.polySphere(name="MySphere")[0]

cmds.move(0, 5, 0, cube)
cmds.rotate(0, 45, 0, sphere)
cmds.scale(2, 2, 2, cube)

cmds.parent(sphere, cube)
group = cmds.group(cube, sphere, name="MyGroup")

# world-space transform read
pos = cmds.xform("MyCube", query=True, translation=True, worldSpace=True)
```

## 2. Scene query and inspection

```python
print("objects:", len(cmds.ls()))
meshes = cmds.ls(type="mesh")
joints = cmds.ls(type="joint")
selected = cmds.ls(selection=True)

if cmds.objExists("MyCube"):
    children = cmds.listRelatives("MyGroup", children=True) or []
    for child in children:
        print("child:", child)

print("shapes:", cmds.listRelatives("MyCube", shapes=True, fullPath=True) or [])
```

## 3. Polygon modeling

```python
cube = cmds.polyCube(name="Model")[0]

cmds.polySubdivideFacet(cube, divisions=3)
cmds.select(f"{cube}.f[5]")
cmds.polyExtrudeFacet(translate=(0, 2, 0))
cmds.select(f"{cube}.e[0:3]")
cmds.polyBevel(offset=0.2, segments=3)
cmds.polySmooth(cube, divisions=2)

cutter = cmds.polyCube(name="Cutter", width=0.5)[0]
cmds.move(0, 0.5, 0, cutter)
cmds.polyCBoolOp(cube, cutter, operation=1)   # 0=union 1=difference 2=intersection
```

## 4. Animation and keyframes

```python
cmds.playbackOptions(min=1, max=120)
cmds.currentTime(1)

ball = cmds.polySphere(name="BouncingBall")[0]
cmds.setKeyframe(ball, attribute="translateY", value=0, time=1)
cmds.setKeyframe(ball, attribute="translateY", value=10, time=15)
cmds.setKeyframe(ball, attribute="translateY", value=0, time=30)
cmds.setKeyframe(ball, attribute="rotateY", value=0, time=1)
cmds.setKeyframe(ball, attribute="rotateY", value=360, time=30)

cmds.keyTangent(ball, attribute="translateY", inTangentType="spline", outTangentType="spline")
cmds.copyKey(ball, attribute="translateY", time=(1, 30))
cmds.pasteKey(ball, time=30)
```

## 5. File operations

```python
cmds.file(rename="C:/projects/scene.ma")
cmds.file(save=True, type="mayaAscii")          # or type="mayaBinary" for .mb
cmds.file("C:/projects/scene.ma", open=True, force=True)
cmds.file("C:/projects/asset.ma", importReference=True)
cmds.file("C:/projects/reference.ma", reference=True, namespace="REF")

cmds.select("MyGroup", replace=True)
cmds.file("C:/projects/exported.ma", type="mayaAscii", exportSelected=True)

print("current scene:", cmds.file(query=True, sceneName=True))
```

## 6. Custom attributes

```python
node = cmds.polySphere(name="AttrDemo")[0]
cmds.addAttr(node, longName="myFloat", defaultValue=0.5, min=0, max=1)
cmds.addAttr(node, longName="myEnum", attributeType="enum", enumName="Off:Low:Medium:High")

cmds.setAttr(f"{node}.myFloat", 0.8)
cmds.setAttr(f"{node}.myEnum", 2)

print("myFloat =", cmds.getAttr(f"{node}.myFloat"))
print("user attrs =", cmds.listAttr(node, userDefined=True) or [])

cmds.connectAttr(f"{node}.myFloat", f"{node}.scaleX")
```

## 7. Materials and shading

```python
sphere = cmds.polySphere(name="ShadedSphere")[0]

shader = cmds.shadingNode("standardSurface", asShader=True, name="MyMaterial")   # Maya 2020: aiStandardSurface / lambert
sg = cmds.sets(renderable=True, noSurfaceShader=True, empty=True, name=f"{shader}SG")
cmds.connectAttr(f"{shader}.outColor", f"{sg}.surfaceShader")

cmds.setAttr(f"{shader}.baseColor", 1, 0.2, 0.2, type="double3")
cmds.setAttr(f"{shader}.specularRoughness", 0.3)

cmds.select(sphere)
cmds.hyperShade(assign=shader)

tex = cmds.shadingNode("file", asTexture=True, name="MyTexture")
cmds.setAttr(f"{tex}.fileTextureName", "C:/textures/diffuse.jpg", type="string")
cmds.connectAttr(f"{tex}.outColor", f"{shader}.baseColor")
```

## 8. Deformers

```python
sphere = cmds.polySphere(name="DeformSphere", subdivisionsX=32, subdivisionsY=24)[0]
cmds.select(sphere)

lattice = cmds.lattice(sphere, name="Lattice1")[0]
bend = cmds.nonLinear(sphere, type="bend", curvature=45, name="Bend1")[0]
twist = cmds.nonLinear(sphere, type="twist", endAngle=180, name="Twist1")[0]

cmds.select(f"{sphere}.vtx[0:10]")
cluster = cmds.cluster(name="Cluster1")[0]

target = cmds.polyCube(name="BlendTarget")[0]
cmds.polyCube(target, edit=True, width=3, height=0.5, depth=0.5)
blend = cmds.blendShape(target, sphere, name="Blend1")[0]
cmds.blendShape(blend, edit=True, weight=(0, 0.5))
```

## 9. Tool window

```python
import maya.cmds as cmds

WINDOW = "myToolWindow"


def build_ui():
    if cmds.window(WINDOW, exists=True):
        cmds.deleteUI(WINDOW)

    cmds.window(WINDOW, title="My Tool", widthHeight=(300, 200))
    cmds.columnLayout(adjustableColumn=True, rowSpacing=10, margin=(10, 10, 10, 10))
    cmds.text(label="My Maya Tool", font="boldLabelFont")
    cmds.separator(height=10)
    cmds.button(label="Create Sphere", command=lambda _: cmds.polySphere())
    cmds.button(label="Create Cube", command=lambda _: cmds.polyCube())
    cmds.button(label="Delete Selected", command=lambda _: cmds.delete(cmds.ls(selection=True)))
    cmds.button(label="Close", command=lambda _: cmds.deleteUI(WINDOW))
    cmds.showWindow(WINDOW)


build_ui()
```

## 10. Batch processing

```python
import os


def batch_export(input_dir, output_dir, pattern=".ma"):
    """Open every matching scene and export STL next to it."""
    os.makedirs(output_dir, exist_ok=True)
    for name in os.listdir(input_dir):
        if not name.endswith(pattern):
            continue
        scene = os.path.join(input_dir, name)
        cmds.file(scene, open=True, force=True)
        stl = os.path.join(output_dir, os.path.splitext(name)[0] + ".stl")
        cmds.file(stl, type="stlExport", exportSelected=False, force=True)
        print("EXPORTED", stl)


def batch_rename(prefix="obj_"):
    for index, obj in enumerate(cmds.ls(selection=True), start=1):
        new_name = f"{prefix}{index:03d}"
        cmds.rename(obj, new_name)
        print("RENAMED", obj, "->", new_name)
```

## Verify before delivering

1. `maya_doc_get` the commands you are least sure about (flags, return values).
2. `maya_standalone` the script in a fresh scene and read stdout — print machine-checkable lines such as `print("RESULT", cmds.ls(type="mesh"))`.
3. If the user has Maya open, `maya_cmd` a small probe first (`cmds.objExists(...)`), then run the real thing.
4. Report exactly how to run it: Script Editor paste, `execfile` from a path, or `mayapy script.py`.

"""Camera positions from an ordinary drone video (structure from motion, pycolmap), first feasibility step.

  .venv/Scripts/python.exe py/drone_sfm.py data/drone/<project> <start_s> <end_s> [fps]

Frames of one continuous shot → SIFT features → matches → sparse reconstruction (camera pose per frame + 3D points).
The model has no scale and no position on the earth: tying it to the map needs control points (see drone_georef.py).
"""
import json
import os
import sys
from pathlib import Path

import cv2
import numpy as np
import pycolmap

root, t0, t1 = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
fps = float(sys.argv[4]) if len(sys.argv) > 4 else 3.0
P = json.load(open(os.path.join(root, 'project.json'), encoding='utf8'))
work = Path(root) / 'sfm'
images = work / 'images'
images.mkdir(parents=True, exist_ok=True)
for old in images.glob('*.jpg'):
    old.unlink()
cap = cv2.VideoCapture(os.path.join(root, P['source']['file']))
times = []
t = t0
while t <= t1 + 1e-6:
    cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
    ok, f = cap.read()
    if not ok:
        break
    name = 'f%06d.jpg' % round(t * 100)
    cv2.imwrite(str(images / name), f, [cv2.IMWRITE_JPEG_QUALITY, 97])
    times.append((name, round(t, 2)))
    t += 1 / fps
print('frames', len(times))
db = work / 'database.db'
if db.exists():
    db.unlink()
reader = pycolmap.ImageReaderOptions()
reader.camera_model = 'SIMPLE_RADIAL'
pycolmap.extract_features(db, images, camera_mode=pycolmap.CameraMode.SINGLE, reader_options=reader)
pairing = pycolmap.SequentialPairingOptions()
pairing.overlap = 12
pairing.quadratic_overlap = True
pycolmap.match_sequential(db, pairing_options=pairing)
out = work / 'sparse'
out.mkdir(exist_ok=True)
maps = pycolmap.incremental_mapping(db, images, out)
best = max(maps.values(), key=lambda m: m.num_reg_images())
best.write(out)
print(best.summary())
cam = list(best.cameras.values())[0]
poses = {}
for im in best.images.values():
    if not im.has_pose:
        continue
    c = im.projection_center()
    poses[im.name] = {'center': [float(x) for x in c], 'cam_from_world': np.asarray(im.cam_from_world().matrix() if callable(im.cam_from_world) else im.cam_from_world.matrix()).tolist()}
json.dump({'times': times, 'camera': {'model': str(cam.model), 'width': cam.width, 'height': cam.height, 'params': [float(x) for x in cam.params]}, 'registered': len(poses), 'frames': len(times), 'points': best.num_points3D(), 'meanReprojectionError': best.compute_mean_reprojection_error(), 'poses': poses}, open(work / 'model.json', 'w'))
print('registered', len(poses), 'of', len(times), 'points', best.num_points3D(), 'reproj', best.compute_mean_reprojection_error(), 'camera', cam.params)

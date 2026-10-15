"""Capture the Windows notification banner for the README and the market card.

Dev helper, not shipped. It shows the exact notification dsh-notify produces,
screenshots the desktop while the banner is on screen, and crops the
bottom-right corner where Windows puts it.

    python scripts/capture-toast.py
"""
from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

from PIL import ImageGrab

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = ROOT / "assets" / "screenshot-1.png"

# The banner is bottom-right; this is a little wider than the toast so the
# rounded corner and the shadow are inside the frame. A near-white desktop
# shows it best, which is a note for whoever re-runs this.
CROP_W = 470
CROP_H = 215
MARGIN = 12


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: capture-toast.py <path-to-node.exe>")
        return 2
    node = Path(sys.argv[1])
    if not node.exists():
        print(f"node not found at {node}")
        return 2

    subprocess.Popen(
        [str(node), "scripts/preview-toast.mjs"],
        cwd=str(ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    time.sleep(2.5)

    shot = ImageGrab.grab(all_screens=True)
    width, height = shot.size
    left = max(0, width - CROP_W - MARGIN)
    top = max(0, height - CROP_H - MARGIN)
    banner = shot.crop((left, top, min(width, left + CROP_W), min(height, top + CROP_H)))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    banner.save(OUT, "PNG")
    print(f"saved {OUT} ({banner.width}x{banner.height}) cropped from ({left},{top}) of {width}x{height}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

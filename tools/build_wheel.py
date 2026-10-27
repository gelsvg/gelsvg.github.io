"""Build the gelsvg wheel the viewer loads, from the library checked out
next to this repository (../gelsvg, or the path given), into
wheels/<hash>/, and point wheels/manifest.json at it. Each build gets a new
folder, so a browser never keeps an old wheel under the same address."""

from __future__ import annotations

import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent


def main() -> None:
    library = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent / "gelsvg"
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run([sys.executable, "-m", "pip", "wheel", "--no-deps", "--no-build-isolation", "--quiet",
                        "-w", tmp, str(library)], check=True)
        (wheel,) = pathlib.Path(tmp).glob("gelsvg-*.whl")
        digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
        wheels = ROOT / "wheels"
        if wheels.exists():
            shutil.rmtree(wheels)
        target = wheels / digest[:16]
        target.mkdir(parents=True)
        shutil.copy2(wheel, target / wheel.name)
    manifest = {"path": f"{digest[:16]}/{wheel.name}", "sha256": digest}
    (wheels / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wheels/{manifest['path']}")


if __name__ == "__main__":
    main()

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "py"), str(ROOT.parent / "gelsvg" / "src")]

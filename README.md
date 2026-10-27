# GelSVG Viewer

A page that opens a GelSVG (`.gel.svg`) file in the browser and shows its
figure, the data each panel carries, and whether the figure still matches
that data. Old MyWB documents (`.mywb.svg`, schema 3–6) are converted to
GelSVG to be shown, and the converted file can be saved.

Files are read in the browser and are never uploaded. The page runs the
[gelsvg](https://github.com/gelsvg/gelsvg) Python library with
[Pyodide](https://pyodide.org); the only network requests fetch Pyodide and
its packages.

## Layout

- `index.html`, `css/`, `js/main.js`: the page.
- `js/worker.js`: starts Pyodide in a Web Worker and installs the library.
- `py/viewer_bridge.py`: what the page asks of the library, as plain data.
- `wheels/`: the library's wheel, built by `tools/build_wheel.py`.

## Working on it

Rebuild the wheel after changing the library (checked out next to this
repository as `../gelsvg`):

    python tools/build_wheel.py

Run the bridge's tests:

    python -m pytest tests

See the page locally (a web server is needed; opening the file directly
does not run the worker):

    python -m http.server 8000

and open <http://localhost:8000>.

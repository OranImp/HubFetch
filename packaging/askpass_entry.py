"""Packaged console entry for the standalone AskPass helper.

``hubfetch.askpass.main`` uses package-relative imports, so it cannot run as a
bare top-level script; this wrapper keeps the package context while remaining
the Analysis entry for the ``HubFetchAskPass`` console EXE.
"""

from hubfetch.askpass.main import entry

if __name__ == "__main__":
    raise SystemExit(entry())

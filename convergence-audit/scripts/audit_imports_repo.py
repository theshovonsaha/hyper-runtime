#!/usr/bin/env python3
"""
audit_imports_repo.py — orphan & import-graph finder for a real repo checkout.

Usage:
    python audit_imports_repo.py <src_root> [--ext .ts,.tsx,.js,.jsx]

Walks the real directory tree and resolves relative imports (./, ../,
index.ts fallback) properly, so it works on nested folder structures, not
just a flat pile of files. Prints:
  1. The full edge list (file -> files it imports, restricted to files inside
     src_root — external packages are not part of this graph).
  2. Files with zero incoming edges — candidates for ORPHANED status. Confirm
     each one manually: a real entrypoint (server bootstrap, CLI main) is
     *expected* to have zero importers; a random utility class is not.

This does not understand TypeScript path aliases (e.g. "@/lib/foo") — if the
repo uses them, resolve those manually or extend `resolve()` below with the
project's tsconfig `paths` mapping before trusting the orphan list.
"""
import argparse
import os
import re


def find_source_files(root, exts):
    files = []
    for dirpath, _, filenames in os.walk(root):
        if "node_modules" in dirpath or "/.git" in dirpath:
            continue
        for fn in filenames:
            if any(fn.endswith(e) for e in exts):
                files.append(os.path.relpath(os.path.join(dirpath, fn), root))
    return files


def build_lookup(files):
    # normalize to forward slashes for consistent matching across platforms
    return {f.replace(os.sep, "/") for f in files}


def resolve(from_file, imp, lookup, exts):
    if not imp.startswith("."):
        return None  # external package (npm, node builtin) — not part of this graph
    base_dir = os.path.dirname(from_file)
    candidate = os.path.normpath(os.path.join(base_dir, imp)).replace(os.sep, "/")
    probe_suffixes = [""] + list(exts) + [f"/index{e}" for e in exts]
    for suffix in probe_suffixes:
        probe = (candidate + suffix).lstrip("./")
        if probe in lookup:
            return probe
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src_root")
    ap.add_argument("--ext", default=".ts,.tsx,.js,.jsx")
    args = ap.parse_args()
    exts = tuple(args.ext.split(","))

    files = find_source_files(args.src_root, exts)
    lookup = build_lookup(files)

    edges = {}
    for f in files:
        full_path = os.path.join(args.src_root, f)
        try:
            text = open(full_path, encoding="utf-8", errors="ignore").read()
        except OSError:
            continue
        imps = re.findall(r"""from\s+['"](\.[^'"]+)['"]""", text)
        imps += re.findall(r"""require\(\s*['"](\.[^'"]+)['"]\s*\)""", text)
        resolved = sorted({resolve(f.replace(os.sep, "/"), i, lookup, exts) for i in imps} - {None})
        edges[f.replace(os.sep, "/")] = resolved

    print("=== EDGE LIST ===")
    for f in sorted(edges):
        tgts = edges[f]
        print(f"{f}\n  -> " + ("\n  -> ".join(tgts) if tgts else "(no local imports)"))

    all_imported = set()
    for tgts in edges.values():
        all_imported.update(tgts)

    print("\n=== ZERO INCOMING EDGES (candidates for ORPHANED — verify manually) ===")
    for f in sorted(files):
        norm = f.replace(os.sep, "/")
        if norm not in all_imported:
            print(" -", norm)

    print(
        "\nNote: files that ARE the real entrypoint (server bootstrap, CLI main, "
        "the file your run/start script points at) are expected to show up here "
        "and are NOT orphaned. Everything else in this list needs a WIRE IN / "
        "MERGE / DELETE decision — see the skill's Phase 3."
    )


if __name__ == "__main__":
    main()

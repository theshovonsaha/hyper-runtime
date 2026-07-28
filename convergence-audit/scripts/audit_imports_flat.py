#!/usr/bin/env python3
"""
audit_imports_flat.py — orphan finder for a flat pile of files (basename matching).

Use this when you only have some subset of a codebase's files (e.g. a user
has been uploading files a few at a time across a conversation, and you don't
have the real directory structure to resolve relative paths against). Matches
imports by basename instead of resolved path, which is much less precise than
audit_imports_repo.py but works with incomplete information.

Usage:
    python audit_imports_flat.py <directory containing the .ts/.js files>

IMPORTANT — this script's output is only as good as the files you've seen so
far. Re-run it every time new files arrive in the conversation; a file that
looks orphaned against 20 known files might turn out to be imported by the
21st file you haven't seen yet. Don't treat a stale run's "orphaned" list as
final — treat it as "orphaned given what we've confirmed exists so far."
"""
import argparse
import glob
import os
import re


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("directory")
    ap.add_argument("--ext", default=".ts,.tsx,.js,.jsx")
    args = ap.parse_args()
    exts = tuple(args.ext.split(","))

    files = []
    for e in exts:
        files.extend(os.path.basename(p) for p in glob.glob(os.path.join(args.directory, f"*{e}")))
    files = sorted(set(files))

    basename_map = {os.path.splitext(f)[0]: f for f in files}

    edges = {}
    for f in files:
        text = open(os.path.join(args.directory, f), encoding="utf-8", errors="ignore").read()
        imports = re.findall(r"""from\s+['"]([^'"]+)['"]""", text)
        local_imports = []
        for imp in imports:
            base = os.path.basename(imp)
            if base in basename_map and basename_map[base] != f:
                local_imports.append(basename_map[base])
        edges[f] = sorted(set(local_imports))

    print("=== IMPORT GRAPH (edges only to files present in this upload set — "
          "external/unresolved imports are dropped, so this UNDERSTATES real usage) ===")
    for f in sorted(edges):
        tgt = edges[f]
        print(f"{f:32s} -> {', '.join(tgt) if tgt else '(none / only external deps)'}")

    all_imported = set()
    for tgts in edges.values():
        all_imported.update(tgts)

    print("\n=== NEVER IMPORTED BY ANY FILE IN THIS SET ===")
    print("(This does NOT mean orphaned in the real repo — it means orphaned")
    print(" given only the files uploaded so far. A file may turn out to be")
    print(" imported by something you haven't seen yet. Re-run as more arrives.)")
    for f in sorted(files):
        if f not in all_imported:
            print(" -", f)


if __name__ == "__main__":
    main()

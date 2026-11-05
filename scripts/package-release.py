#!/usr/bin/env python3
"""Create reproducible shareable release packages, excluding local state and credentials."""
from pathlib import Path
import argparse
import hashlib
import json
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
EXCLUDED = {".git", "node_modules", "dist", ".next", ".vinext", ".wrangler", ".sites-runtime", ".local-runtime", ".venv", "__pycache__", "artifacts", "verification-results", ".openai", "coverage"}


def eligible(path):
    rel = path.relative_to(ROOT)
    if not path.is_file() or path.is_symlink() or any(p in EXCLUDED or p.startswith("rerun-") for p in rel.parts):
        return False
    if rel.as_posix().startswith("apps/workbench/public/data/"):
        return False
    name = path.name
    if name.endswith((".pyc", ".tsbuildinfo", ".pem", ".key", ".sqlite", ".sqlite3", ".db")):
        return False
    if (name.startswith(".env") or name.startswith(".dev.vars")) and not name.endswith(".example"):
        return False
    return name not in (".DS_Store", "Thumbs.db", "next-env.d.ts")


def package(destination, files, prefix=""):
    files = sorted(files, key=lambda item: item[1])
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path, name in files:
            info = zipfile.ZipInfo(prefix + name, date_time=(2026, 11, 5, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o100755 if path.suffix == ".sh" else 0o100644) << 16
            archive.writestr(info, path.read_bytes())
    with zipfile.ZipFile(destination) as archive:
        assert archive.testzip() is None, destination.name
    return {"name": destination.name, "files": len(files), "bytes": destination.stat().st_size,
            "sha256": hashlib.sha256(destination.read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    subprocess.run([sys.executable, str(ROOT / "scripts" / "verify-data.py")], check=True)
    records = []
    if (ROOT / ".git").exists():
        status = subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True)
        if status.strip():
            raise RuntimeError("Commit the reviewed source changes before creating a release package.")
        tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).decode("utf-8").split("\0")
        candidates = [ROOT / p for p in tracked if p]
    else:
        candidates = ROOT.rglob("*")
    source = [(p, p.relative_to(ROOT).as_posix()) for p in candidates if eligible(p) and output not in p.parents]
    records.append(package(output / "CAISO-GitHub-Codex.zip", source, "caiso-market-desk/"))
    data_files = [(p, p.relative_to(ROOT).as_posix()) for p in (ROOT / "data").rglob("*") if p.is_file()]
    records.append(package(output / "CAISO-Public-Data.zip", data_files))
    site = ROOT / "apps" / "viewer" / "dist"
    if (site / "index.html").is_file():
        records.append(package(output / "CAISO-Pages-Site.zip", [(p, p.relative_to(site).as_posix()) for p in site.rglob("*") if p.is_file()]))
    (output / "SHA256SUMS.txt").write_text("".join(f"{r['sha256']}  {r['name']}\n" for r in records), encoding="utf-8")
    (output / "release-manifest.json").write_text(json.dumps({"schemaVersion": 1, "packages": records}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "packages": records}, ensure_ascii=False))


if __name__ == "__main__":
    main()

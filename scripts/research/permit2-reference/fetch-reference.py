"""Refresh the unchanged public reference source dependency closure; no execution."""
import hashlib
import json
import pathlib
import posixpath
import re
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent
REVISIONS = {
    "permit2": ("Uniswap/permit2", "cc56ad0f3439c502c246fc5cfcc3db92bb8b7219"),
    # Gitlink lib/solmate in the Permit2 revision above.
    "solmate": ("transmissions11/solmate", "8d910d876f51c3b2585c9109409d601f600e68e1"),
}
records = {}


def fetch(project, path):
    key = f"{project}/{path}"
    if key in records:
        return
    repository, revision = REVISIONS[project]
    url = f"https://raw.githubusercontent.com/{repository}/{revision}/{path}"
    content = subprocess.check_output(
        ["curl", "--fail", "--silent", "--show-error", "--max-time", "30", url]
    )
    target = ROOT / key
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)
    records[key] = {
        "url": url,
        "sha256": hashlib.sha256(content).hexdigest(),
        "gitBlobSha1": hashlib.sha1(
            f"blob {len(content)}\0".encode() + content
        ).hexdigest(),
    }
    if path.endswith(".sol"):
        for dependency in re.findall(r'"([^"\n]+\.sol)"', content.decode()):
            if dependency.startswith("solmate/"):
                fetch("solmate", dependency.removeprefix("solmate/"))
            else:
                fetch(project, posixpath.normpath(posixpath.join(posixpath.dirname(path), dependency)))


fetch("permit2", "src/AllowanceTransfer.sol")
fetch("permit2", "test/mocks/MockERC20.sol")
fetch("permit2", "LICENSE")
fetch("solmate", "LICENSE")
(ROOT / "provenance.json").write_text(json.dumps({
    "repositories": {k: {"repository": v[0], "revision": v[1]} for k, v in REVISIONS.items()},
    "files": dict(sorted(records.items())),
}, indent=2) + "\n")
print(f"Pinned {len(records)} source/license files; source content unchanged.")

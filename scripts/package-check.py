"""Verify the normalized CPS archive, file hashes and declared resources."""
import argparse
import hashlib
import json
import tarfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--protocol-version", type=int, default=7)
parser.add_argument("packages", nargs="+")
args = parser.parse_args()

for argument in args.packages:
    path = Path(argument)
    with tarfile.open(path) as archive:
        members = {member.name: member for member in archive.getmembers()}
        assert all(m.isfile() for m in members.values()), "Unexpected archive entry"
        manifest = json.load(archive.extractfile("plugin.json"))
        assert manifest["manifestVersion"] == 2
        package = manifest["package"]
        assert package["protocolVersion"] == args.protocol_version
        for name, digest in package["files"].items():
            assert hashlib.sha256(archive.extractfile(name).read()).hexdigest() == digest, name
        assert set(members) == {"plugin.json", *package["files"]}
        assert members[manifest["main"]].mode & 0o111
        binary = archive.extractfile(manifest["main"]).read(4)
        assert binary == (b"\x7fELF" if package["target"]["os"] == "linux" else b"\xcf\xfa\xed\xfe")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    assert digest in Path(str(path) + ".sha256").read_text()
    print(f"OK {path.name} sha256={digest}")

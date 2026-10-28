#!/usr/bin/env python3
"""Build a self-describing manifest for one complete FigTree backup set."""
import argparse
import datetime
import hashlib
import json
import os
import tarfile


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def file_record(path, role):
    return {"name": os.path.basename(path), "role": role,
            "bytes": os.path.getsize(path), "sha256": sha256_file(path)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--dump", required=True)
    parser.add_argument("--attachments")
    parser.add_argument("--projects")
    parser.add_argument("--metadata", required=True)
    parser.add_argument("--retention", choices=("rolling", "archive"), required=True)
    parser.add_argument("--app-version", required=True)
    parser.add_argument("--secondary-state", required=True,
                        choices=("copied", "not_configured", "unavailable", "not_applicable"))
    parser.add_argument("--secondary-target", default="")
    parser.add_argument("--secondary-error", default="")
    args = parser.parse_args()

    with open(args.metadata, encoding="utf-8") as source:
        metadata = json.load(source)

    problems = []
    files = [file_record(args.dump, "postgres-custom-archive")]
    inventory = []
    archived_blobs = {}

    if args.attachments and os.path.isfile(args.attachments):
        files.append(file_record(args.attachments, "attachment-store"))
        try:
            with tarfile.open(args.attachments, "r:gz") as archive:
                for member in archive.getmembers():
                    item = {"path": member.name, "bytes": member.size, "kind": "file"}
                    if member.islnk():
                        item.update({"kind": "hardlink", "target": member.linkname})
                        stream = archive.extractfile(member)
                        digest = hashlib.sha256(stream.read()).hexdigest() if stream else None
                        item["sha256"] = digest
                    elif member.issym():
                        item.update({"kind": "symlink", "target": member.linkname})
                    elif member.isfile():
                        stream = archive.extractfile(member)
                        digest = hashlib.sha256(stream.read()).hexdigest() if stream else None
                        item["sha256"] = digest
                    else:
                        item["kind"] = "directory" if member.isdir() else "other"
                    base = os.path.basename(member.name)
                    if ("/blobs/" in member.name and len(base) == 64
                            and (member.isfile() or member.islnk())):
                        archived_blobs[base] = item.get("sha256")
                        if item.get("sha256") != base:
                            problems.append("attachment blob %s does not match its hash name" % base)
                    inventory.append(item)
        except (tarfile.TarError, OSError) as error:
            problems.append("attachment archive cannot be read: %s" % error)
    else:
        problems.append("attachment store was not archived")

    expected = sorted(set(metadata.get("attachment_sha256", [])))
    missing = sorted(value for value in expected if archived_blobs.get(value) != value)
    if missing:
        problems.append("%d referenced attachment blob(s) are missing or changed" % len(missing))

    project_expected = {"%s/%s/blobs/%s" % (b["entity"], b["project"], b["sha256"]): b
                        for b in metadata.get("project_blobs", [])}
    project_inventory = []
    project_archived = {}
    if args.projects and os.path.isfile(args.projects):
        files.append(file_record(args.projects, "project-attachment-store"))
        try:
            with tarfile.open(args.projects, "r:gz") as archive:
                for member in archive.getmembers():
                    if not member.isfile() or member.issym():
                        continue
                    parts = member.name.split("/")
                    if len(parts) < 5 or parts[-2] != "blobs":
                        continue
                    key = "/".join(parts[-4:])
                    stream = archive.extractfile(member)
                    digest = hashlib.sha256(stream.read()).hexdigest() if stream else None
                    project_archived[key] = {"sha256": digest, "bytes": member.size}
                    project_inventory.append({"path": member.name, "bytes": member.size, "sha256": digest})
                    if len(parts[-1]) == 64 and digest != parts[-1]:
                        problems.append("Project blob %s does not match its hash name" % key)
        except (tarfile.TarError, OSError) as error:
            problems.append("Project archive cannot be read: %s" % error)
    project_missing = sorted(k for k, b in project_expected.items()
                             if project_archived.get(k) != {"sha256": b["sha256"], "bytes": b["bytes"]})
    if project_missing:
        problems.append("%d referenced Project blob(s) are missing or changed" % len(project_missing))

    complete = not problems
    created = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    manifest = {
        "format": "figtree-full-backup-v2", "created_at": created,
        "scope": "complete-system", "retention_class": args.retention,
        "complete": complete, "problems": problems,
        "software": {"name": "FigTree", "version": args.app_version},
        "database": {"name": metadata.get("database"),
                     "server_version": metadata.get("server_version"),
                     "schema": metadata.get("schema")},
        "counts": metadata.get("counts", {}), "files": files,
        "attachments": {"expected_referenced_blobs": len(expected),
                        "archived_blobs": len(archived_blobs),
                        "missing_or_changed": missing, "inventory": inventory},
        "project_attachments": {"expected_referenced_blobs": len(project_expected),
                                "archived_blobs": len(project_archived),
                                "missing_or_changed": project_missing, "inventory": project_inventory},
        "secondary_copy": {"state": args.secondary_state,
                           "target": args.secondary_target or None,
                           "error": args.secondary_error or None},
        "restore_verification": {"verified_at": None, "machine": None,
                                 "new_machine_verified_at": None},
        "integrity_note": "Checksums detect changes; they do not prove an administrator never altered the data.",
    }

    temporary = args.manifest + ".tmp"
    with open(temporary, "w", encoding="utf-8") as target:
        json.dump(manifest, target, ensure_ascii=False, indent=2, sort_keys=True)
        target.write("\n")
    os.replace(temporary, args.manifest)
    os.chmod(args.manifest, 0o600)

    print(json.dumps({
        "database": metadata.get("database"), "file": os.path.basename(args.dump),
        "manifest": os.path.basename(args.manifest), "bytes": os.path.getsize(args.dump),
        "posted_entries": metadata.get("counts", {}).get("posted_entries", 0),
        "audit_rows": metadata.get("counts", {}).get("audit_rows", 0),
        "retention_class": args.retention, "complete": complete, "problems": problems,
        "attachments": "attachments archived and verified" if args.attachments else "ATTACHMENTS NOT BACKED UP",
        "project_attachments": "Project files archived and verified" if args.projects and not project_missing else "no Project files" if not project_expected else "PROJECT ATTACHMENTS NOT BACKED UP",
        "secondary": manifest["secondary_copy"],
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()

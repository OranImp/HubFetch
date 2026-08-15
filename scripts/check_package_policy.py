# noqa: D100
import ast
import json
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from scripts import license_manifest  # noqa: E402
from scripts._policy_constants import (  # noqa: E402
    BANNED_BINARY,
    DATABASE_PATH,
    EXPECTED_COLLECT,
    EXPECTED_ENTRYPOINTS,
    FORBIDDEN_SEGMENT,
    GPL_ONLY_QT_DLLS,
    GPL_ONLY_QT_MODULES,
    QT_RUNTIME_SUPPORT_DLLS,
    REQUIRED_QT_DLLS,
    REQUIRED_RESOURCES,
    VC_RUNTIME_DLLS,
)
from scripts._spec_model import SpecModel, parse_spec  # noqa: E402

__all__ = ["GPL_ONLY_QT_MODULES", "parse_spec"]


@dataclass(frozen=True, slots=True)
class PolicyFailure:
    rule: str
    message: str


@dataclass(frozen=True, slots=True)
class PolicyReport:
    passed: bool
    failures: tuple[PolicyFailure, ...]
    inventory: Mapping[str, object]


def _check_entry_points(model: SpecModel) -> list[PolicyFailure]:
    failures: list[PolicyFailure] = []
    actual = {(entry.name, entry.console) for entry in model.entrypoints}
    if actual != set(EXPECTED_ENTRYPOINTS):
        failures.append(
            PolicyFailure(
                "entry-points",
                f"expected {sorted(EXPECTED_ENTRYPOINTS)}, found {sorted(actual)}",
            )
        )
    if model.collect_name != EXPECTED_COLLECT:
        failures.append(
            PolicyFailure(
                "collect-layout", f"expected COLLECT named {EXPECTED_COLLECT}"
            )
        )
    return failures


def _check_forbidden_paths(model: SpecModel) -> list[PolicyFailure]:
    failures: list[PolicyFailure] = []
    for destination, basename in model.resource_plan:
        entry = f"{destination}/{basename}"
        if BANNED_BINARY.match(basename):
            failures.append(
                PolicyFailure("bundled-binary", f"{entry}: Git/Xet/hf binary")
            )
        if DATABASE_PATH.search(destination) or DATABASE_PATH.search(basename):
            failures.append(PolicyFailure("database-path", f"{entry}: database file"))
        if FORBIDDEN_SEGMENT.intersection(destination.split("/")):
            failures.append(
                PolicyFailure("forbidden-path", f"{entry}: forbidden segment")
            )
    return failures


def _check_qt_modules(model: SpecModel) -> list[PolicyFailure]:
    failures: list[PolicyFailure] = []
    excluded = set(model.excludes)
    hidden = set(model.hidden_imports)
    missing = GPL_ONLY_QT_MODULES - excluded
    if missing:
        failures.append(
            PolicyFailure("gpl-only-qt-exclude", f"not excluded: {sorted(missing)}")
        )
    present = GPL_ONLY_QT_MODULES.intersection(hidden)
    if present:
        failures.append(
            PolicyFailure("gpl-only-qt-import", f"hidden-imported: {sorted(present)}")
        )
    return failures


def _check_resources(spec_path: Path, model: SpecModel) -> list[PolicyFailure]:
    failures: list[PolicyFailure] = []
    missing_resources = REQUIRED_RESOURCES - set(model.resource_plan)
    if missing_resources:
        message = f"missing: {sorted(missing_resources)}"
        failures.append(PolicyFailure("required-resources", message))
    missing_dlls = REQUIRED_QT_DLLS - set(model.expected_qt_dlls)
    if missing_dlls:
        message = f"missing Qt DLLs: {sorted(missing_dlls)}"
        failures.append(PolicyFailure("replaceable-qt-dlls", message))
    source = spec_path.read_text(encoding="utf-8")
    calls_dynamic = any(
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "collect_dynamic_libs"
        for node in ast.walk(ast.parse(source))
    )
    if calls_dynamic:
        message = 'collect_dynamic_libs("PySide6") forbidden: copies every PySide6 DLL'
        failures.append(PolicyFailure("collect-dynamic-libs-forbidden", message))
    if "_QT_BINARY_PLAN" not in source:
        failures.append(
            PolicyFailure("qt-dll-plan-missing", "spec must declare _QT_BINARY_PLAN")
        )
    return failures


def _check_licenses(repo_root: Path) -> list[PolicyFailure]:
    lock = (repo_root / "uv.lock").read_text(encoding="utf-8")
    overrides = license_manifest.parse_overrides(
        (repo_root / "packaging" / "license_overrides.toml").read_text(encoding="utf-8")
    )
    parsed = license_manifest.parse_lock(lock)
    violations = license_manifest.license_violations(parsed, overrides)
    return [PolicyFailure("license-policy", f"{violation}") for violation in violations]


def _check_dist_artifact(dist_internal: Path, model: SpecModel) -> list[PolicyFailure]:
    runtime_root = (
        dist_internal / "_internal"
        if (dist_internal / "_internal").is_dir()
        else dist_internal
    )
    pyside6_dir = runtime_root / "PySide6"
    if not pyside6_dir.is_dir():
        return [
            PolicyFailure("dist-artifact-missing", f"no PySide6 dir at {pyside6_dir}")
        ]
    relative = [
        str(path.relative_to(runtime_root)).replace("\\", "/")
        for path in runtime_root.rglob("*")
        if path.is_file()
    ]
    failures: list[PolicyFailure] = []

    def scan(
        rule: str,
        actual: set[str],
        required: set[str] | frozenset[str],
        allowed: set[str] | frozenset[str] | None = None,
    ) -> None:
        allowed = frozenset() if allowed is None else allowed
        extras = sorted((actual - required) - allowed)
        missing = sorted(required - actual)
        if extras or missing:
            failures.append(PolicyFailure(rule, f"extras={extras} missing={missing}"))

    scan(
        "dist-pyside6-dlls",
        {path.name.lower() for path in pyside6_dir.glob("*.dll") if path.is_file()},
        {name.lower() for name in REQUIRED_QT_DLLS - {"shiboken6.abi3.dll"}},
        VC_RUNTIME_DLLS | QT_RUNTIME_SUPPORT_DLLS,
    )
    scan(
        "dist-plugins",
        {rel for rel in relative if rel.startswith("PySide6/plugins/")},
        {
            f"{d}/{b}"
            for d, b in model.resource_plan
            if d.startswith("PySide6/plugins/")
        },
    )
    scan(
        "dist-translations",
        {rel for rel in relative if rel.startswith("PySide6/translations/")},
        {f"{d}/{b}" for d, b in model.resource_plan if d == "PySide6/translations"},
    )
    gpl_names = {name.casefold() for name in GPL_ONLY_QT_DLLS}
    gpl = sorted(rel for rel in relative if Path(rel).name.casefold() in gpl_names)
    if gpl:
        failures.append(
            PolicyFailure("dist-gpl-only-qt-dll", f"GPL-only Qt DLLs: {gpl}")
        )
    qml = [rel for rel in relative if rel.startswith("PySide6/qml/")]
    if qml:
        failures.append(PolicyFailure("dist-qml-tree", f"QML tree present: {qml[:5]}"))
    return failures


def run_policy(
    spec_path: Path, repo_root: Path, dist_internal: Path | None = None
) -> PolicyReport:
    model = parse_spec(spec_path)
    failures: list[PolicyFailure] = []
    if model.one_file:
        failures.append(
            PolicyFailure("one-file-forbidden", "one-file EXE mode is prohibited")
        )
    if model.upx:
        failures.append(PolicyFailure("upx-forbidden", "UPX compression is prohibited"))
    if dist_internal is not None:
        failures.extend(_check_dist_artifact(dist_internal, model))
    failures.extend(
        _check_entry_points(model)
        + _check_forbidden_paths(model)
        + _check_qt_modules(model)
        + _check_resources(spec_path, model)
        + _check_licenses(repo_root)
    )
    parsed = license_manifest.parse_lock(
        (repo_root / "uv.lock").read_text(encoding="utf-8")
    )
    inventory: dict[str, object] = {
        "spec": str(spec_path),
        "entrypoints": [(entry.name, entry.console) for entry in model.entrypoints],
        "collect": model.collect_name,
        "resource_plan_size": len(model.resource_plan),
        "excluded_modules": len(model.excludes),
        "runtime_packages": sorted(license_manifest.runtime_package_names(parsed)),
    }
    return PolicyReport(not failures, tuple(failures), inventory)


def main(arguments: Sequence[str] | None = None) -> int:
    args = list(arguments if arguments is not None else sys.argv[1:])
    json_path: Path | None = None
    dist_internal: Path | None = None
    for flag in ("--json", "--dist"):
        if flag in args:
            index = args.index(flag)
            if index + 1 >= len(args):
                print(f"check-package-policy: {flag} requires a path", file=sys.stderr)
                return 2
            if flag == "--json":
                json_path = Path(args.pop(index + 1))
            else:
                dist_internal = Path(args.pop(index + 1))
            _ = args.pop(index)
    if len(args) != 1:
        print(
            "usage: check-package-policy <spec> [--json|--dist <path>]", file=sys.stderr
        )
        return 2
    try:
        report = run_policy(Path(args[0]), _REPO_ROOT, dist_internal)
    except (OSError, ValueError) as error:
        print(f"check-package-policy: {error}", file=sys.stderr)
        return 2
    payload = {
        "passed": report.passed,
        "failures": [
            {"rule": failure.rule, "message": failure.message}
            for failure in report.failures
        ],
        "inventory": report.inventory,
    }
    if json_path is not None:
        _ = json_path.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
    for failure in report.failures:
        print(
            f"check-package-policy: [{failure.rule}] {failure.message}", file=sys.stderr
        )
    return 0 if report.passed else 1


if __name__ == "__main__":
    sys.exit(main())

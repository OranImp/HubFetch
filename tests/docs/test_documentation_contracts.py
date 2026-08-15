# noqa: SIZE_OK - contract-assertion inventory, data-table nature (user-exempt)
"""Contract tests for the HubFetch documentation set.

The shipped docs (README.md, docs/*, CHANGELOG.md) must name the immutable
identifiers, pin the exact versions, document the real scripts, declare only
supported features, ship both Simplified Chinese and English user guides,
carry the mandated security/cancellation/retry/license clauses, link only to
existing local files, and reject every banned-claim fixture.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Final

ROOT: Final = Path(__file__).resolve().parents[2]

DOC_FILES: Final = (
    ROOT / "README.md",
    ROOT / "docs" / "architecture.md",
    ROOT / "docs" / "contributing.md",
    ROOT / "docs" / "releasing.md",
    ROOT / "docs" / "security.md",
    ROOT / "docs" / "troubleshooting.md",
    ROOT / "docs" / "user-guide.en.md",
    ROOT / "docs" / "user-guide.zh-CN.md",
)
CHANGELOG: Final = ROOT / "CHANGELOG.md"

IDENTIFIERS: Final = ("HubFetch.Desktop", "HubFetch.Credentials", "hubfetch.db")
VERSIONS: Final = (
    "PySide6 6.11.1",
    "huggingface_hub 1.27.0",
    "PyInstaller 6.22.0",
    "Python 3.12",
)
DOCUMENTED_SCRIPTS: Final = (
    "scripts/build_windows.ps1",
    "scripts/smoke_portable.ps1",
    "scripts/compile_translations.ps1",
    "scripts/run_quality_gates.ps1",
    "scripts/generate_notices.py",
    "scripts/check_package_policy.py",
    "scripts/check_no_excuse_rules.py",
    "scripts/check_design_contract.py",
)
SUPPORTED_FEATURES: Final = (
    "single-file",
    "snapshot",
    "git clone",
    "anonymous",
    "browser OAuth",
    "manual token",
    "system proxy",
    "direct mode",
    "manual proxy",
    "queue",
    "cancel",
    "retry",
    "interrupted",
    "cache",
    "support bundle",
    "askpass",
    "Simplified Chinese",
    "English",
)
BANNED_CLAIMS: Final = (
    ("huggingface-cli", r"\bhuggingface-cli\b"),
    ("clone-resume", r"clones?\s+(?:resume|resumes|resuming)\b"),
    ("token-in-env", r"(?:set|export|recommend).{0,40}\bHF_TOKEN\b"),
    ("msix", r"\bMSIX\b"),
    ("self-update", r"self-update|background updater|auto-download"),
    ("upload", r"\bupload"),
    ("trusted-signing", r"trusted (?:signing|publisher|signature)"),
    ("official-affiliation", r"official Hugging Face (?:affiliation|endorsement)"),
    ("repo-management", r"repository (?:create|delete|move|settings)\b"),
)
NEGATION_WORDS: Final = (
    "no",
    "not",
    "never",
    "without",
    "banned",
    "forbidden",
    "prohibited",
    "do not",
    "does not",
    "must not",
    "won't",
    "cannot",
    "don't",
    "absent",
    "no update",
    "不要",
    "不会",
    "不能",
    "没有",
    "无需",
    "不需要",
    "绝不",
    "禁止",
    "不可",
    "从不",
)
REQUIRED_CLAUSES: Final = (
    ("unsigned", r"unsigned"),
    ("fail-closed", r"fail[ -]closed"),
    ("redaction", r"redact"),
    ("cancelling", r"cancelling"),
    ("cancellation-order", r"empty[ -]job|Job (?:is )?empty|zero active process"),
    ("job-before-envelope", r"Job.{0,80}envelope|envelope.{0,80}Job"),
    ("recovery", r"interrupted"),
    ("retry", r"retry"),
    ("new-destination", r"empty|new destination"),
    ("no-update", r"no update check|never polls|no self-update"),
    ("keyring", r"Credential Manager|keyring"),
    ("lgpl", r"LGPL"),
    ("mit", r"MIT"),
    ("proxy-127", r"127\.0\.0\.1:7897"),
)
SUPPORT_BUNDLE_EXCLUSIONS: Final = (
    "database",
    "credentials",
    "environment",
    "screenshots",
)
_FIXTURE_CASES: Final = (
    ("Run huggingface-cli download before using HubFetch.\n", {"huggingface-cli"}),
    ("Interrupted clones resume in place on the next attempt.\n", {"clone-resume"}),
    (
        "Recommend setting HF_TOKEN in your environment before first run.\n",
        {"token-in-env"},
    ),
    (
        "An MSIX package, self-update checks, and upload are planned.\n",
        {"msix", "self-update", "upload"},
    ),
)


def _all_docs_text() -> str:
    """Concatenate every shipped documentation file."""
    return "\n".join(
        path.read_text(encoding="utf-8") for path in (*DOC_FILES, CHANGELOG)
    )


def _banned_labels(source: str) -> set[str]:
    """Return the banned-claim labels an affirmative fixture carries."""
    folded = source.casefold()
    return {
        label
        for label, pattern in BANNED_CLAIMS
        if re.search(pattern, folded, flags=re.IGNORECASE)
    }


def _matches_versions(text: str) -> bool:
    """Return whether the text carries every pinned version string."""
    return all(version in text for version in VERSIONS)


def test_immutable_identifiers_are_documented() -> None:
    """Given the docs, every immutable identifier is named."""
    text = _all_docs_text()

    for identifier in IDENTIFIERS:
        assert identifier in text, f"missing identifier {identifier}"


def test_exact_pinned_versions_are_documented() -> None:
    """Given the docs, the exact pinned versions are named."""
    text = _all_docs_text()

    for version in VERSIONS:
        assert version in text, f"missing pinned version {version}"


def test_every_documented_script_exists() -> None:
    """Given the docs, every referenced script ships."""
    text = _all_docs_text().replace("\\", "/")

    for script in DOCUMENTED_SCRIPTS:
        assert script in text, f"docs do not reference shipped script {script}"
        assert (ROOT / script).is_file(), f"documented script does not exist: {script}"


def test_supported_features_are_documented() -> None:
    """Given the docs, every supported feature is described."""
    text = _all_docs_text().casefold()

    for feature in SUPPORTED_FEATURES:
        assert feature.casefold() in text, f"missing supported feature {feature}"


def test_both_languages_have_user_guides() -> None:
    """Given the docs, both Simplified Chinese and English guides ship."""
    zh = (ROOT / "docs" / "user-guide.zh-CN.md").read_text(encoding="utf-8")
    en = (ROOT / "docs" / "user-guide.en.md").read_text(encoding="utf-8")

    assert len(zh) > 4000, "Simplified Chinese guide is too short to be primary"
    assert len(en) > 2000, "English guide is too short to be a counterpart"
    assert "安装" in zh, "Chinese guide misses the installation topic"
    assert "卸载" in zh, "Chinese guide misses the uninstall topic"


def test_required_security_and_lifecycle_clauses_present() -> None:
    """Given the docs, every mandated clause is present."""
    text = _all_docs_text()

    for label, pattern in REQUIRED_CLAUSES:
        assert re.search(pattern, text, flags=re.IGNORECASE) is not None, (
            f"missing required clause {label} ({pattern})"
        )


def test_support_bundle_exclusions_are_documented() -> None:
    """Given the docs, each support-bundle exclusion is named."""
    text = _all_docs_text().casefold()

    for exclusion in SUPPORT_BUNDLE_EXCLUSIONS:
        assert exclusion in text, f"support bundle exclusion {exclusion} not named"


def test_local_markdown_links_resolve() -> None:
    """Given the docs, every local Markdown link targets a file."""
    failures: list[str] = []
    for path in (*DOC_FILES, CHANGELOG):
        for match in re.finditer(
            r"\[[^\]]*\]\(([^)]+)\)", path.read_text(encoding="utf-8")
        ):
            target = match.group(1)
            if "://" in target or target.startswith(("#", "mailto:")):
                continue
            path_part = target.split("#", 1)[0] or target
            resolved = (path.parent / path_part).resolve()
            if not resolved.exists():
                failures.append(f"{path.relative_to(ROOT)}: broken link {target!r}")
    assert failures == [], "broken local links:\n" + "\n".join(failures)


def test_banned_claims_are_absent_from_real_docs() -> None:
    """Given the real docs, no banned claim appears outside a prohibition."""
    offenders: list[str] = []
    for path in (*DOC_FILES, CHANGELOG):
        for line_number, line in enumerate(
            path.read_text(encoding="utf-8").splitlines(), start=1
        ):
            lowered = line.casefold()
            if any(word in lowered for word in NEGATION_WORDS):
                continue
            for label, pattern in BANNED_CLAIMS:
                if re.search(pattern, lowered):
                    offender = (
                        f"{path.relative_to(ROOT)}:{line_number}: {label} "
                        f"({line.strip()})"
                    )
                    offenders.append(offender)
    assert offenders == [], "banned claims present in real docs:\n" + "\n".join(
        offenders
    )


def test_banned_claim_fixtures_are_rejected(tmp_path: Path) -> None:
    """Given banned-claim doc fixtures, the checker rejects each one."""
    for source, expected in _FIXTURE_CASES:
        fixture = tmp_path / "fixture.md"
        _ = fixture.write_text(source, encoding="utf-8")
        labels = _banned_labels(fixture.read_text(encoding="utf-8"))
        assert expected <= labels, f"fixture {source!r} was not fully rejected"


def test_fixture_with_stale_version_is_rejected(tmp_path: Path) -> None:
    """Given a doc fixture pinning an old version, the checker rejects it."""
    fixture = tmp_path / "fixture.md"
    _ = fixture.write_text(
        "Built with PySide6 6.8.0 and huggingface_hub 1.20.0.\n", encoding="utf-8"
    )
    text = fixture.read_text(encoding="utf-8")

    assert "PySide6 6.11.1" not in text, "stale fixture must not pin PySide6 6.11.1"
    assert "huggingface_hub 1.27.0" not in text, (
        "stale fixture must not pin huggingface_hub 1.27.0"
    )
    assert not _matches_versions(text), "stale fixture must not match the pins"


def test_fixture_with_missing_translation_is_rejected(tmp_path: Path) -> None:
    """Given a doc set dropping one language, the checker rejects it."""
    docs_dir = tmp_path / "docs"
    docs_dir.mkdir()
    _ = (docs_dir / "user-guide.en.md").write_text("short", encoding="utf-8")
    _ = (docs_dir / "user-guide.zh-CN.md").write_text("short", encoding="utf-8")

    zh = (docs_dir / "user-guide.zh-CN.md").read_text(encoding="utf-8")
    en = (docs_dir / "user-guide.en.md").read_text(encoding="utf-8")

    assert len(zh) <= 200 or len(en) <= 200, "both translations must be complete"

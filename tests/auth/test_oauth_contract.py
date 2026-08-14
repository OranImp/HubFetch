"""Given/When/Then tests for the pinned Hub OAuth adapter contract.

The contract test imports every pinned Hub OAuth symbol exclusively from
``hubfetch.auth.oauth_contract``: no other module may import the Hub's private
OAuth primitives, and the import-policy test enforces that rule.
"""

from __future__ import annotations

import inspect
from pathlib import Path
from typing import TYPE_CHECKING, Final

from hubfetch.auth import oauth_contract
from hubfetch.auth.oauth_contract import DeviceCodeInfo, OAuthTokenResponse

if TYPE_CHECKING:
    from collections.abc import Callable

_PINNED_EXPIRED: Final = "expired_token"  # pinned upstream enum value
_PINNED_DENIED: Final = "access_denied"  # pinned upstream enum value


class _FakeDeviceCodeError(Exception):
    """Exception shaped like the Hub's ``DeviceCodeError``."""

    error_code: str | None = "expired_token"


class TestPinnedSurface:
    def test_verify_contract_reports_available_on_installed_1_27_0(self) -> None:
        state = oauth_contract.verify_contract()
        assert state.available is True
        assert state.unavailable_reason is None

    def test_primitives_are_the_real_upstream_functions(self) -> None:
        assert (
            oauth_contract.request_device_code.__module__
            == "huggingface_hub.utils._oauth_device"
        )
        assert (
            oauth_contract.poll_device_token.__module__
            == "huggingface_hub.utils._oauth_device"
        )
        assert oauth_contract.login.__module__ == "huggingface_hub._login"
        assert (
            oauth_contract.get_stored_tokens.__module__ == "huggingface_hub.utils._auth"
        )

    def test_save_token_wraps_login_with_a_narrow_signature(self) -> None:
        signature = inspect.signature(oauth_contract.save_token)
        assert tuple(signature.parameters) == ("token",)


class TestExactUpstreamSignatures:
    def test_request_device_code_matches_the_pinned_signature(self) -> None:
        assert (
            oauth_contract.check_callable_signature(
                oauth_contract.request_device_code,
                oauth_contract.EXPECTED_REQUEST_DEVICE_CODE,
            )
            is None
        )

    def test_poll_device_token_matches_the_pinned_signature(self) -> None:
        assert (
            oauth_contract.check_callable_signature(
                oauth_contract.poll_device_token,
                oauth_contract.EXPECTED_POLL_DEVICE_TOKEN,
            )
            is None
        )

    def test_login_matches_the_pinned_signature(self) -> None:
        assert (
            oauth_contract.check_callable_signature(
                oauth_contract.login,
                oauth_contract.EXPECTED_LOGIN,
            )
            is None
        )

    def test_get_stored_tokens_matches_the_pinned_signature(self) -> None:
        assert (
            oauth_contract.check_callable_signature(
                oauth_contract.get_stored_tokens,
                oauth_contract.EXPECTED_STORED_TOKENS,
            )
            is None
        )


class TestPinnedShapes:
    def test_device_code_info_shape_is_pinned(self) -> None:
        assert DeviceCodeInfo.__required_keys__ == frozenset(
            {
                "device_code",
                "expires_in",
                "interval",
                "user_code",
                "verification_uri",
                "verification_uri_complete",
            }
        )

    def test_oauth_token_response_shape_is_pinned(self) -> None:
        assert OAuthTokenResponse.__optional_keys__ == frozenset(
            {"access_token", "expires_in", "refresh_token", "token_type"}
        )

    def test_oauth_error_code_enum_is_exposed_with_pinned_values(self) -> None:
        assert oauth_contract.OAuthErrorCode.EXPIRED_TOKEN == _PINNED_EXPIRED
        assert oauth_contract.OAuthErrorCode.ACCESS_DENIED == _PINNED_DENIED


class TestDeviceCodeErrorCode:
    def test_extracts_named_error_code_from_hub_shaped_error(self) -> None:
        error = _FakeDeviceCodeError("denied")
        assert oauth_contract.device_code_error_code(error) == "expired_token"

    def test_returns_none_for_unrelated_exception(self) -> None:
        assert oauth_contract.device_code_error_code(ValueError("x")) is None


class TestGracefulDegradation:
    def test_missing_primitives_report_hub_import(self) -> None:
        state = oauth_contract.verify_contract(
            request_code=None,
            poll=None,
            login_fn=None,
            stored_tokens=None,
        )
        assert state.available is False
        assert state.unavailable_reason == "hub_import"

    def test_drifted_request_code_disables_the_contract(self) -> None:
        def drifted(force: bool = False) -> DeviceCodeInfo:
            del force
            return DeviceCodeInfo(
                device_code="d",
                expires_in=900,
                interval=5,
                user_code="u",
                verification_uri="v",
                verification_uri_complete="c",
            )

        state = oauth_contract.verify_contract(request_code=drifted)
        assert state.available is False
        assert state.unavailable_reason == "signature_drift"

    def test_drifted_poll_disables_the_contract(self) -> None:
        def drifted(
            device_info: DeviceCodeInfo,
            *,
            on_pending: Callable[[], None] | None = None,
            extra: bool = True,
        ) -> OAuthTokenResponse:
            del device_info, on_pending, extra
            return {"access_token": "t"}

        state = oauth_contract.verify_contract(poll=drifted)
        assert state.available is False
        assert state.unavailable_reason == "signature_drift"

    def test_drifted_login_disables_the_contract(self) -> None:
        def drifted(token: str) -> None:
            del token

        state = oauth_contract.verify_contract(login_fn=drifted)
        assert state.available is False
        assert state.unavailable_reason == "signature_drift"

    def test_check_callable_signature_fails_closed_for_c_function(self) -> None:
        # ``inspect.signature`` on a builtin yields ``(*args, **kwargs)``,
        # which never matches the pinned spec: the checker degrades rather
        # than guess, so the adapter stays disabled.
        assert (
            oauth_contract.check_callable_signature(len, oauth_contract.EXPECTED_LOGIN)
            is not None
        )


class TestImportPolicy:
    def test_private_hub_oauth_imports_live_only_in_oauth_contract(self) -> None:
        root = Path(__file__).resolve().parents[2] / "src" / "hubfetch"
        contract = root / "auth" / "oauth_contract.py"
        markers = (
            "_oauth_device",
            "utils._auth",
            "huggingface_hub._login",
            "request_device_code",
            "poll_device_token",
            "_save_token",
            "DeviceCodeError",
            "OAuthErrorCode",
        )
        violations: list[str] = []
        for path in sorted(root.rglob("*.py")):
            if path == contract:
                continue
            for number, line in enumerate(
                path.read_text(encoding="utf-8").splitlines(), start=1
            ):
                stripped = line.strip()
                if not stripped.startswith(("import ", "from ")):
                    continue
                if "huggingface_hub" in stripped and any(
                    marker in stripped for marker in markers
                ):
                    violations.append(f"{path.relative_to(root)}:{number}:{stripped}")
        assert violations == []

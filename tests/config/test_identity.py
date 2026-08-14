"""Tests for the immutable HubFetch application identity."""

from dataclasses import FrozenInstanceError, fields

import pytest

from hubfetch.config.identity import AppIdentity


def test_app_identity_uses_only_locked_identifiers() -> None:
    """Given the identity model, the locked identifiers are exact and complete."""
    identity = AppIdentity()

    assert identity.display_name == "HubFetch"
    assert identity.application_family_id == "HubFetch.Desktop"
    assert identity.credentials_service == "HubFetch.Credentials"
    assert identity.database_filename == "hubfetch.db"
    assert {field.name for field in fields(identity)} == {
        "display_name",
        "application_family_id",
        "credentials_service",
        "database_filename",
    }


def test_app_identity_is_frozen() -> None:
    """Given an identity instance, changing an identifier is rejected."""
    identity = AppIdentity()
    field_name = "display_name"

    with pytest.raises(FrozenInstanceError):
        setattr(identity, field_name, "Other")

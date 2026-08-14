"""Immutable identifiers shared by the HubFetch desktop application."""

from dataclasses import dataclass
from typing import Final


@dataclass(frozen=True, slots=True)
class AppIdentity:
    """Stable names used for display, Qt scoping, credentials, and storage."""

    display_name: str = "HubFetch"
    application_family_id: str = "HubFetch.Desktop"
    credentials_service: str = "HubFetch.Credentials"
    database_filename: str = "hubfetch.db"


APP_IDENTITY: Final = AppIdentity()
"""The one immutable application identity used by configuration boundaries."""

"""Safe message formatting with literal parameters and plural templates.

Every UI-facing message is requested by a stable message ID plus a mapping of
parameters; this module never interprets parameter values as format syntax.
``{name}`` placeholders are substituted literally (single pass, values are
never rescanned), so a parameter such as ``"{0.__class__} %s"`` renders as
verbatim text instead of leaking into attribute access or printf formatting.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, override

if TYPE_CHECKING:
    from collections.abc import Mapping

_PLACEHOLDER_PATTERN: Final = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")
"""Matches one ``{name}`` parameter placeholder inside a message template."""


@dataclass(frozen=True, slots=True)
class MissingParameterError(ValueError):
    """A message template referenced a parameter that was not supplied."""

    message_id: str
    parameter: str

    @override
    def __str__(self) -> str:
        return f"message {self.message_id!r} requires parameter {self.parameter!r}"


def format_template(
    template: str,
    params: Mapping[str, str | int | float],
    *,
    message_id: str = "<unknown>",
) -> str:
    """Substitute every ``{name}`` placeholder with its literal parameter value.

    Placeholder resolution is a single regex pass over the template; a value
    that itself contains braces or percent signs is inserted verbatim and is
    never re-interpreted. A template referencing a missing parameter raises a
    typed :class:`MissingParameterError` so the caller fixes the contract
    instead of rendering a partially formatted message.
    """
    result: list[str] = []
    position = 0
    for match in _PLACEHOLDER_PATTERN.finditer(template):
        name = match.group(1)
        if name not in params:
            raise MissingParameterError(message_id=message_id, parameter=name)
        result.append(template[position : match.start()])
        result.append(str(params[name]))
        position = match.end()
    result.append(template[position:])
    return "".join(result)


def format_plural(template: str, count: int) -> str:
    """Choose a ``|``-separated plural form of a template by ``count``.

    The first form is the singular (``count == 1``) and any later form is the
    plural; a template without a separator is returned unchanged. The selected
    form then substitutes ``{count}`` literally.
    """
    forms = template.split("|")
    index = 0 if count == 1 else (1 if len(forms) > 1 else 0)
    return format_template(forms[index], {"count": count})

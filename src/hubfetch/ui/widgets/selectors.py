"""Repository-type selector built on a standard combo box.

The selector exposes the three discriminated repository kinds (model, dataset,
Space) with a leading shape icon per kind so the choice is never conveyed by
color alone. Item data carries the closed :class:`RepositoryTypeChoice` value,
which maps one-for-one onto the domain's repository discriminator literals.
"""

from __future__ import annotations

from enum import StrEnum, unique

from PySide6.QtWidgets import QComboBox, QLabel, QVBoxLayout, QWidget

from hubfetch.ui import fonts, icons, tokens


@unique
class RepositoryTypeChoice(StrEnum):
    """Closed repository kinds selectable before creating a transfer task."""

    MODEL = "model"
    DATASET = "dataset"
    SPACE = "space"


_KIND_ICONS: dict[RepositoryTypeChoice, icons.IconName] = {
    RepositoryTypeChoice.MODEL: icons.IconName.DATABASE,
    RepositoryTypeChoice.DATASET: icons.IconName.GLOBE,
    RepositoryTypeChoice.SPACE: icons.IconName.FOLDER,
}


class RepositoryTypeSelector(QWidget):
    """A labeled combo box choosing one of the three repository kinds."""

    def __init__(self, label_text: str) -> None:
        """Build label plus combo box with icon-bearing kind items."""
        super().__init__()
        self._combo: QComboBox = QComboBox()
        self._choices: tuple[RepositoryTypeChoice, ...] = tuple(RepositoryTypeChoice)
        label = QLabel(label_text)
        label.setBuddy(self._combo)
        self._combo.setAccessibleName(label_text)
        self._combo.setFixedHeight(tokens.CONTROL_HEIGHT)
        self._combo.setMinimumWidth(tokens.FIELD_MIN_WIDTH)
        self._combo.setFont(fonts.ui_font(tokens.BODY_SIZE))
        for choice in RepositoryTypeChoice:
            self._combo.addItem(
                icons.icon(
                    _KIND_ICONS[choice],
                    self.palette().text().color(),
                    tokens.ICON_INLINE,
                ),
                self._kind_label(choice),
                userData=choice,
            )
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(tokens.SPACE_1)
        layout.addWidget(label)
        layout.addWidget(self._combo)
        self.setAccessibleName(label_text)

    def combo(self) -> QComboBox:
        """Expose the underlying combo box."""
        return self._combo

    def count(self) -> int:
        """Return how many repository kinds are offered."""
        return self._combo.count()

    def current_choice(self) -> RepositoryTypeChoice:
        """Return the selected repository kind."""
        index = self._combo.currentIndex()
        if index < 0 or index >= len(self._choices):
            message = "repository selector holds no valid kind"
            raise ValueError(message)
        return self._choices[index]

    def set_current_choice(self, choice: RepositoryTypeChoice) -> None:
        """Select a repository kind by its closed value."""
        try:
            index = self._choices.index(choice)
        except ValueError as error:
            message = f"unknown repository choice {choice.value}"
            raise ValueError(message) from error
        self._combo.setCurrentIndex(index)

    def _kind_label(self, choice: RepositoryTypeChoice) -> str:
        match choice:
            case RepositoryTypeChoice.MODEL:
                return "模型 (Model)"
            case RepositoryTypeChoice.DATASET:
                return "数据集 (Dataset)"
            case RepositoryTypeChoice.SPACE:
                return "应用 (Space)"


__all__ = ["RepositoryTypeChoice", "RepositoryTypeSelector"]

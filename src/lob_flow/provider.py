from __future__ import annotations

from collections.abc import Iterator

from lob_flow.models import DraftDefinition


class FakeModelProvider:
    """A deterministic local provider used to verify the runtime without a key."""

    def stream(self, definition: DraftDefinition, user_input: str) -> Iterator[str]:
        if user_input == "__fail__":
            raise RuntimeError("Fake model failure requested by input")

        try:
            rendered = definition.user_prompt_template.format(input=user_input)
        except (KeyError, ValueError) as exc:
            raise ValueError(f"Invalid user prompt template: {exc}") from exc

        response = f"[FakeModel] {rendered}"
        for index in range(0, len(response), 8):
            yield response[index : index + 8]

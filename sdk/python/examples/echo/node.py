#!/usr/bin/env python3
"""A minimal, complete Python node package: one type, "echo", that emits back whatever its
input carried. Read this file end to end before writing your own -- everything it calls is
documented in docs/authors/python-sdk.md.

innytypes_node.py, beside this file, is a vendored copy of the SDK (see its own header) --
Python has no bundler to inline a dependency the way esbuild does for the TypeScript example,
so this package ships with zero dependencies and no requirements.lock at all (spec 2.3.3: no
lock file means no dependencies).
"""

from innytypes_node import Node


def main() -> None:
    node = Node(ports=["out"])

    def on_input(input_id: str, event: dict) -> None:
        node.emit("out", event.get("data"), input_id)
        node.done(input_id)

    node.run(on_input=on_input)


if __name__ == "__main__":
    main()

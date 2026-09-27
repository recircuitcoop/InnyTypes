# innytypes-node

The Python node SDK for InnyTypes node packages: node protocol v2
(`docs/specs/node-protocol-v2.md`, Appendix A), standard library only.

```python
from innytypes_node import Node

node = Node()  # reads and checks the start frame (spec 4.1)

def on_input(input_id: str, event: dict) -> None:
    node.emit("out", event["data"], input_id)
    node.done(input_id)

node.run(on_input=on_input)
```

See `docs/authors/python-sdk.md` for the full guide (declaration, packaging, signing,
catalogue listing) and `examples/echo` for a package that installs into the dev app.

## Development

```
uv sync --frozen
uv run ruff check src tests
uv run ruff format --check src tests
uv run mypy
uv run pytest --cov --cov-fail-under=90
```

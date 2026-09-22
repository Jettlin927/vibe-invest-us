import ast
from pathlib import Path


def test_financial_domain_has_no_transport_or_storage_dependencies():
    root = Path(__file__).parents[1] / "app"
    for layer in ("domain", "service", "api", "adapters"):
        for path in (root / layer).rglob("*.py"):
            for node in ast.walk(ast.parse(path.read_text())):
                if isinstance(node, ast.ImportFrom):
                    modules = [node.module or ""]
                elif isinstance(node, ast.Import):
                    modules = [alias.name for alias in node.names]
                else:
                    continue
                for module in modules:
                    assert not module.startswith(("psycopg", "sqlite3")), (path, module)
                    if layer == "domain":
                        assert not module.startswith(("fastapi", "app.api", "app.service", "app.adapters", "urllib.request", "requests")), (path, module)
                    if layer in ("service", "adapters"):
                        assert not module.startswith(("fastapi", "app.api")), (path, module)
                    if layer == "api":
                        assert not module.startswith("app.adapters"), (path, module)

import json
import time
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app
from app.adapters import _PinnedHTTPConnection, _diagnose, configure_diagnostics, validate_document_url
from app.models import Quote
from datetime import datetime, timezone


def test_health_reports_financial_data_service_ready():
    response = TestClient(app).get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "service": "financial-data",
        "status": "ok",
    }


def test_openapi_contract_matches_application():
    contract_path = Path(__file__).parents[3] / "contracts/market-data/openapi.json"
    contract = json.loads(contract_path.read_text())

    assert app.openapi() == contract


def test_quote_batch_uses_fallback_without_exposing_provider_payload(monkeypatch):
    class FailedSource:
        name = "primary"
        def __init__(self, timeout=15):
            self.timeout = timeout
        def fetch(self, _symbol):
            raise RuntimeError("down")

    class BackupSource:
        name = "backup"
        def __init__(self, timeout=15):
            self.timeout = timeout
        def fetch(self, symbol):
            return Quote(
                price=123.5,
                observed_at=datetime(2026, 8, 12, tzinfo=timezone.utc),
                source_reference=f"https://example.com/{symbol}",
            )

    monkeypatch.setitem(__import__("app.main", fromlist=["source_config"]).source_config, "quote", [
        {"name": "primary", "enabled": True, "priority": 10},
        {"name": "backup", "enabled": True, "priority": 20},
    ])
    monkeypatch.setitem(__import__("app.source_config", fromlist=["SOURCE_CLASSES"]).SOURCE_CLASSES, "quote", {
        "primary": FailedSource, "backup": BackupSource,
    })
    response = TestClient(app).post("/v1/quotes", json=["nvda", "amd"])

    assert response.status_code == 200
    assert response.json()["quotes"][0] == {
        "symbol": "NVDA", "price": 123.5,
        "observed_at": "2026-08-12T00:00:00Z", "source": "backup",
        "degraded": True,
        "sources": [
            {"source": "primary", "status": "failed", "error": "RuntimeError", "item_count": 0},
            {"source": "backup", "status": "ok", "error": None, "item_count": 1},
        ],
    }


def test_diagnostic_sample_is_bounded_redacted_and_expires(tmp_path):
    configure_diagnostics(True, tmp_path, max_bytes=128, retention_hours=1)
    expired = tmp_path / "expired.sample"
    expired.write_text("old")
    old_time = time.time() - 7200
    __import__("os").utime(expired, (old_time, old_time))

    _diagnose("https://example.com", b'{"api_key":"secret-value","email":"me@example.com","data":"' + b"x" * 200 + b'"}')
    samples = list(tmp_path.glob("*.sample"))
    assert len(samples) == 1
    content = samples[0].read_text()
    assert "secret-value" not in content
    assert "me@example.com" not in content
    assert len(samples[0].read_bytes()) <= 128
    configure_diagnostics(False, tmp_path, max_bytes=128, retention_hours=1)


def test_document_url_rejects_non_http_and_non_public_addresses(monkeypatch):
    monkeypatch.setattr("app.adapters.socket.getaddrinfo", lambda host, port, type=0: [
        (2, 1, 6, "", ("127.0.0.1", port)),
    ])
    for url in ["file:///etc/passwd", "http://127.0.0.1/", "http://169.254.169.254/latest/meta-data"]:
        try:
            validate_document_url(url)
        except ValueError as error:
            assert str(error) == "news_document_url_not_public"
        else:
            raise AssertionError(f"unsafe_url_accepted:{url}")


def test_document_url_normalizes_public_http_address(monkeypatch):
    monkeypatch.setattr("app.adapters.socket.getaddrinfo", lambda host, port, type=0: [
        (2, 1, 6, "", ("93.184.216.34", port)),
    ])
    assert validate_document_url("HTTPS://Example.COM:443/news#fragment") == "https://example.com/news"


def test_document_connection_uses_the_prevalidated_ip_without_resolving_hostname(monkeypatch):
    connected = []
    sentinel = object()
    monkeypatch.setattr("app.adapters.socket.create_connection", lambda address, *args: (
        connected.append(address) or sentinel
    ))
    connection = _PinnedHTTPConnection("example.com", "93.184.216.34", 80, 1)
    connection.connect()
    assert connection.sock is sentinel
    assert connected == [("93.184.216.34", 80)]

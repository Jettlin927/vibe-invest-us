import json
import time
from email.message import Message
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app
from app.adapters import (
    _PinnedHTTPConnection, YahooValuationSource, _diagnose, configure_diagnostics, read_document_page,
    validate_document_url,
)
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


def test_technical_endpoints_publish_scope_and_pagination_contracts():
    schema = app.openapi()

    assert schema["paths"]["/v1/technical-evidence"]["post"]["operationId"] == "getTechnicalEvidence"
    assert schema["paths"]["/v1/price-window"]["post"]["operationId"] == "getPriceWindow"


def test_yahoo_valuation_preserves_each_metric_fact_date(monkeypatch):
    payload = {"timeseries": {"result": [{
        "meta": {"type": ["trailingDilutedEPS"]},
        "trailingDilutedEPS": [{
            "asOfDate": "2026-07-31", "reportedValue": {"raw": 4.2},
        }],
    }, {
        "meta": {"type": ["trailingEnterpriseValue"]},
        "trailingEnterpriseValue": [{
            "asOfDate": "2026-08-12", "reportedValue": {"raw": 500},
        }],
    }, {
        "meta": {"type": ["trailingPeRatio"]},
        "trailingPeRatio": [
            {"asOfDate": "2025-08-12", "reportedValue": {"raw": 24}},
            {"asOfDate": "2026-08-12", "reportedValue": {"raw": 28}},
        ],
    }]}}
    monkeypatch.setattr("app.adapters._read", lambda *args, **kwargs: json.dumps(payload))

    metrics = YahooValuationSource()._metrics("NVDA")

    assert metrics["observedAt"] == {
        "dilutedEps": "2026-07-31", "enterpriseValue": "2026-08-12", "pe": "2026-08-12",
    }
    assert metrics["historicalPe"] == [
        {"value": 24, "observedAt": "2025-08-12"},
        {"value": 28, "observedAt": "2026-08-12"},
    ]


def test_yahoo_valuation_without_quote_uses_latest_input_fact_date(monkeypatch):
    source = YahooValuationSource()
    monkeypatch.setattr(source, "_metrics", lambda symbol: {
        "dilutedEps": 4, "pe": 28, "enterpriseValue": 500,
        "ebitda": 25, "revenue": 100,
        "observedAt": {"dilutedEps": "2026-07-31", "pe": "2026-08-12"},
    })

    result = source.fetch_with_market_price("NVDA", None, None)

    assert result.as_of == "2026-08-12"
    assert "marketPrice" not in result.input_observed_at
    assert result.input_observed_at["company.dilutedEps"] == "2026-07-31"
    assert result.input_observed_at["comparables.AMD.pe"] == "2026-08-12"


def test_financial_overview_hides_xbrl_mapping_and_returns_official_facts(monkeypatch):
    from app.models import AtomicFact, FactQueryResult
    expected = FactQueryResult(facts=[AtomicFact(
        id="fact:NVDA:financial:revenue:2026-Q2", type="reported_financial",
        value={"metric": "revenue", "period": "2026-Q2", "value": 30_000_000_000, "currency": "USD"},
        observedAt="2026-07-31T00:00:00Z", fetchedAt="2026-08-13T00:00:00Z",
        source="sec", sourceReference="https://www.sec.gov/Archives/example", evidenceLevel="reported_financial",
    )])
    monkeypatch.setattr("app.main.financial_overview_facts", lambda symbol, now, source: (
        {"symbol": symbol, "latestPeriod": "2026-Q2", "qualityFlags": []}, expected.facts, expected.sources,
    ))

    response = TestClient(app).post("/v1/financial-overview", params={"symbol": "nvda"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["overview"] == {"symbol": "NVDA", "latestPeriod": "2026-Q2", "qualityFlags": []}
    assert payload["facts"][0]["evidenceLevel"] == "reported_financial"
    assert all(key not in json.dumps(payload) for key in ["concept", "unit", "form", "frame"])


def test_financial_metric_series_http_returns_complete_pagination_metadata(monkeypatch):
    from app.models import PaginatedFactResult
    monkeypatch.setattr("app.main.financial_metric_series_result", lambda symbol, metric, cursor, source, now: (
        PaginatedFactResult(
            facts=[], returnedCount=0, totalCount=4, nextCursor=None, truncated=False,
        )
    ))

    response = TestClient(app).post("/v1/financial-metric-series", params={
        "symbol": "nvda", "metric": "revenue_yoy", "cursor": "2",
    })

    assert response.status_code == 200
    assert response.json() == {
        "facts": [], "sources": [], "eligibility": None,
        "returnedCount": 0, "totalCount": 4, "nextCursor": None, "truncated": False,
    }


def test_valuation_evidence_http_returns_host_calculated_facts_and_method_states(monkeypatch):
    from app.models import AtomicFact, ValuationEvidenceResult
    expected = ValuationEvidenceResult(
        symbol="NVDA", authorizedComparables=["AMD", "AVGO", "QCOM"],
        comparables=[{"symbol": "AMD", "pe": 28}],
        currentMultiples={"pe": 30}, historicalRanges={"pe": [18, 34]},
        methods={"dcf": {"status": "unavailable", "reason": "not_implemented"}},
        facts=[AtomicFact(
            id="fact:NVDA:deterministic-valuation:pe:abc", type="deterministic_valuation",
            value={"method": "pe", "inputs": ["fact:eps", "fact:price"],
                   "formula": "diluted_eps * adopted_comparable_pe", "unit": "USD/share",
                   "targetPrice": 112, "range": {"low": 80, "high": 128},
                   "asOf": "2026-08-12T14:30:00Z"},
            observedAt="2026-08-12T14:30:00Z", fetchedAt="2026-08-13T00:00:00Z",
            source="deterministic-calculation", sourceReference="source://valuation",
            evidenceLevel="deterministic_valuation",
        )],
    )
    monkeypatch.setattr("app.main.valuation_evidence_result", lambda symbol, now, quote, source: expected)

    response = TestClient(app).post("/v1/valuation-evidence", params={"symbol": "nvda"})

    assert response.status_code == 200
    assert response.json()["symbol"] == "NVDA"
    assert response.json()["authorizedComparables"] == ["AMD", "AVGO", "QCOM"]
    assert response.json()["comparables"] == [{"symbol": "AMD", "pe": 28}]
    assert response.json()["facts"][0]["evidenceLevel"] == "deterministic_valuation"
    assert "targetPrice" not in response.json()["methods"]["dcf"]


def test_valuation_evidence_result_combines_input_and_method_facts_once():
    from app.context import valuation_evidence_result
    from app.valuation import ValuationInput, calculate_valuation

    class ValuationSource:
        def fetch_with_market_price(self, symbol, price, observed_at):
            return calculate_valuation(ValuationInput(
                symbol=symbol, industry="semiconductor", current_price=120,
                diluted_eps=4, enterprise_value=500, ebitda=25, revenue=100,
                comparables=[{"symbol": "AMD", "pe": 28, "evToEbitda": 18}],
                source="test-valuation", as_of="2026-08-12T14:30:00Z",
            ))

    result = valuation_evidence_result(
        "NVDA", datetime(2026, 8, 13, tzinfo=timezone.utc), [], ValuationSource(),
    )

    assert [fact.type for fact in result.facts] == [
        "valuation_inputs", "deterministic_valuation", "deterministic_valuation",
    ]


def test_filing_document_http_uses_sec_adapter_and_returns_bounded_page(monkeypatch):
    monkeypatch.setattr("app.main.SecFilingSource.fetch", lambda self, symbol, filing_id: {
        "filingId": filing_id, "form": "10-Q", "filedAt": "2026-07-31",
        "sourceReference": "https://www.sec.gov/Archives/edgar/data/example.htm",
    })
    monkeypatch.setattr("app.main.SecFilingSource.fetch_page", lambda self, filing, cursor: {
        **filing, "summary": "Revenue increased.", "contentHash": "a" * 64,
        "startByte": 0, "endByte": 127, "totalBytes": 400,
        "nextCursor": "128", "truncated": True,
    })

    response = TestClient(app).post("/v1/filing-document", params={
        "symbol": "nvda", "filing_id": "0001045810-26-000123",
    })

    assert response.status_code == 200
    payload = response.json()
    assert payload["returnedCount"] == 128
    assert payload["totalCount"] == 400
    assert payload["nextCursor"] == "128"
    assert payload["truncated"] is True
    assert payload["facts"][0]["evidenceLevel"] == "official_filing"
    assert payload["facts"][0]["value"]["contentHash"] == "a" * 64


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


def test_document_page_sends_byte_range_and_uses_provider_total(monkeypatch):
    requests = []

    class Response:
        status = 206
        headers = Message()
        headers["Content-Type"] = "text/html"
        headers["Content-Range"] = "bytes 65536-65540/200000"
        def read(self, _limit):
            return b"abcde"

    class Connection:
        def __init__(self, *args):
            pass
        def request(self, method, path, headers):
            requests.append((method, path, headers))
        def getresponse(self):
            return Response()
        def close(self):
            pass

    monkeypatch.setattr("app.adapters._resolve_document_url", lambda url: (
        url, "93.184.216.34", 443, "example.com",
    ))
    monkeypatch.setattr("app.adapters._PinnedHTTPSConnection", Connection)

    page = read_document_page("https://example.com/filing", 65536, 65536)

    assert requests[0][2]["Range"] == "bytes=65536-131071"
    assert page["startByte"] == 65536
    assert page["endByte"] == 65540
    assert page["totalBytes"] == 200000
    assert page["nextCursor"] == "65541"
    assert page["truncated"] is True


def test_document_page_fails_closed_when_provider_ignores_nonzero_range(monkeypatch):
    class Response:
        status = 200
        headers = Message()
        headers["Content-Type"] = "text/html"
        headers["Content-Length"] = "200000"
        def read(self, _limit):
            return b"abcde"

    class Connection:
        def __init__(self, *args):
            pass
        def request(self, method, path, headers):
            pass
        def getresponse(self):
            return Response()
        def close(self):
            pass

    monkeypatch.setattr("app.adapters._resolve_document_url", lambda url: (
        url, "93.184.216.34", 443, "example.com",
    ))
    monkeypatch.setattr("app.adapters._PinnedHTTPSConnection", Connection)

    try:
        read_document_page("https://example.com/filing", 65536, 65536)
    except ValueError as error:
        assert str(error) == "document_range_not_supported"
    else:
        raise AssertionError("ignored_range_accepted")

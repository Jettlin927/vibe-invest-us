import gzip
import http.client
import ipaddress
import json
import os
import re
import socket
import ssl
import time
from hashlib import sha256
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import List
from urllib.parse import urlencode, urljoin, urlsplit, urlunsplit
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from xml.etree import ElementTree
from zoneinfo import ZoneInfo

from app.models import DailyBar, NewsItem, Quote
from app.financials import build_financials
from app.valuation import ValuationInput, calculate_valuation


USER_AGENT = "Mozilla/5.0 vibe-invest-us/0.1"


_diagnostics = {"enabled": False, "directory": None, "max_bytes": 65536, "retention_seconds": 86400}


def configure_diagnostics(enabled: bool, directory: Path, max_bytes: int, retention_hours: int):
    _diagnostics.update(enabled=enabled, directory=directory, max_bytes=max_bytes,
                        retention_seconds=retention_hours * 3600)


def _read(url: str, params=None, headers=None, timeout=15) -> bytes:
    target = f"{url}?{urlencode(params)}" if params else url
    request = Request(target, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urlopen(request, timeout=timeout) as response:
        payload = response.read()
        if response.headers.get("Content-Encoding", "").lower() == "gzip":
            payload = gzip.decompress(payload)
    _diagnose(target, payload)
    return payload


ALLOWED_DOCUMENT_CONTENT_TYPES = {"text/html", "text/plain", "application/xhtml+xml"}


def validate_document_url(url: str) -> str:
    return _resolve_document_url(url)[0]


def _resolve_document_url(url: str):
    parsed = urlsplit(url)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("news_document_url_not_public")
    port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    try:
        addresses = socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)
    except OSError as error:
        raise ValueError("news_document_url_not_public") from error
    if not addresses:
        raise ValueError("news_document_url_not_public")
    verified_addresses = []
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global:
            raise ValueError("news_document_url_not_public")
        verified_addresses.append(str(ip))
    host = parsed.hostname.lower()
    default_port = (parsed.scheme.lower() == "https" and parsed.port in {None, 443}) \
        or (parsed.scheme.lower() == "http" and parsed.port in {None, 80})
    normalized_host = f"[{host}]" if ":" in host else host
    authority = normalized_host if default_port else f"{normalized_host}:{parsed.port}"
    normalized = urlunsplit((parsed.scheme.lower(), authority, parsed.path or "/", parsed.query, ""))
    return normalized, verified_addresses[0], port, host


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, hostname: str, pinned_ip: str, port: int, timeout: float):
        super().__init__(hostname, port=port, timeout=timeout)
        self._pinned_ip = pinned_ip

    def connect(self):
        self.sock = socket.create_connection(
            (self._pinned_ip, self.port), self.timeout, self.source_address,
        )


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, hostname: str, pinned_ip: str, port: int, timeout: float):
        super().__init__(hostname, port=port, timeout=timeout, context=ssl.create_default_context())
        self._pinned_ip = pinned_ip

    def connect(self):
        raw_socket = socket.create_connection(
            (self._pinned_ip, self.port), self.timeout, self.source_address,
        )
        self.sock = self._context.wrap_socket(raw_socket, server_hostname=self.host)


def read_limited_document(url: str, max_bytes: int, timeout: float = 10):
    page = read_document_page(url, 0, max_bytes, timeout)
    return (
        page["payload"], page["contentType"], page["truncated"], page["sourceReference"],
    )


def read_document_page(url: str, cursor: int, max_bytes: int, timeout: float = 10):
    if cursor < 0 or max_bytes < 1:
        raise ValueError("document_cursor_invalid")
    target = url
    for _redirect in range(6):
        safe_url, pinned_ip, port, hostname = _resolve_document_url(target)
        parsed = urlsplit(safe_url)
        connection_class = _PinnedHTTPSConnection if parsed.scheme == "https" else _PinnedHTTPConnection
        connection = connection_class(hostname, pinned_ip, port, timeout)
        path = urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
        try:
            end_byte = cursor + max_bytes - 1
            connection.request("GET", path, headers={
                "User-Agent": USER_AGENT, "Host": parsed.netloc,
                "Range": f"bytes={cursor}-{end_byte}",
            })
            response = connection.getresponse()
            if response.status in {301, 302, 303, 307, 308}:
                location = response.headers.get("Location")
                if not location:
                    raise ValueError("news_document_redirect_invalid")
                target = urljoin(safe_url, location)
                continue
            if response.status not in {200, 206}:
                raise ValueError("news_document_http_status")
            content_type = response.headers.get_content_type()
            if content_type not in ALLOWED_DOCUMENT_CONTENT_TYPES:
                raise ValueError("news_document_content_type_not_allowed")
            payload = response.read(max_bytes + 1)[:max_bytes]
            content_range = response.headers.get("Content-Range")
            total_bytes = None
            start_byte = cursor
            if response.status == 206:
                match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", content_range or "")
                if not match or int(match.group(1)) != cursor:
                    raise ValueError("document_content_range_invalid")
                start_byte, provider_end, total_bytes = map(int, match.groups())
                if provider_end != start_byte + len(payload) - 1:
                    raise ValueError("document_content_range_invalid")
            elif cursor != 0:
                raise ValueError("document_range_not_supported")
            else:
                content_length = response.headers.get("Content-Length")
                if content_length and content_length.isdigit():
                    total_bytes = int(content_length)
            end_byte = start_byte + len(payload) - 1
            next_cursor = end_byte + 1 if total_bytes is not None and end_byte + 1 < total_bytes else None
            truncated = next_cursor is not None or (total_bytes is None and len(payload) == max_bytes)
            return {
                "payload": payload, "contentType": content_type, "sourceReference": safe_url,
                "startByte": start_byte, "endByte": end_byte, "totalBytes": total_bytes,
                "nextCursor": str(next_cursor) if next_cursor is not None else None,
                "truncated": truncated,
            }
        finally:
            connection.close()
    raise ValueError("news_document_redirect_limit")


def _diagnose(target: str, payload: bytes):
    if not _diagnostics["enabled"]:
        return
    directory = _diagnostics["directory"]
    directory.mkdir(parents=True, exist_ok=True)
    now = time.time()
    for existing in directory.glob("*.sample"):
        if now - existing.stat().st_mtime > _diagnostics["retention_seconds"]:
            existing.unlink(missing_ok=True)
    name = sha256(f"{target}:{now}".encode()).hexdigest()
    sanitized = _sanitize_diagnostic(payload[:_diagnostics["max_bytes"]])
    (directory / f"{name}.sample").write_bytes(sanitized)


def _sanitize_diagnostic(payload: bytes) -> bytes:
    text = payload.decode("utf-8", errors="replace")
    patterns = (
        (r'(?i)(api[_-]?key|access[_-]?token|authorization|cookie)(["\']?\s*[:=]\s*["\']?)([^"\'\s,&}]+)', r'\1\2[REDACTED]'),
        (r'(?i)(bearer\s+)[a-z0-9._~+\-/=]+', r'\1[REDACTED]'),
        (r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', '[REDACTED_EMAIL]'),
    )
    for pattern, replacement in patterns:
        text = re.sub(pattern, replacement, text)
    return text.encode("utf-8")[:_diagnostics["max_bytes"]]


class TimedSource:
    def __init__(self, timeout=15):
        self.timeout = timeout


def search_web(query: str, timeout: float = 10):
    if not query or len(query) > 500:
        raise ValueError("web_search_query_invalid")
    target = f"https://www.bing.com/search?{urlencode({'q': query, 'format': 'rss'})}"
    with urlopen(Request(target, headers={"User-Agent": USER_AGENT}), timeout=timeout) as response:
        payload = response.read(262145)
        if len(payload) > 262144:
            raise ValueError("web_search_response_too_large")
    root = ElementTree.fromstring(payload)
    results = []
    for item in root.findall("./channel/item")[:10]:
        title, link = item.findtext("title"), item.findtext("link")
        parsed = urlsplit(link) if link else None
        if title and parsed and parsed.scheme.lower() in {"http", "https"} and parsed.hostname:
            results.append({
                "title": title, "url": link,
                "summary": item.findtext("description") or title,
            })
    return results


class AlpacaSource(TimedSource):
    name = "alpaca"

    @property
    def feed(self) -> str:
        feed = os.getenv("ALPACA_DATA_FEED", "iex").strip().lower()
        if feed not in {"iex", "sip"}:
            raise ValueError("ALPACA_DATA_FEED_invalid")
        return feed

    def read(self, path: str, params=None):
        key_id = os.getenv("ALPACA_API_KEY", "").strip()
        secret_key = os.getenv("ALPACA_API_SECRET", "").strip()
        if not key_id or not secret_key:
            raise RuntimeError("alpaca_credentials_missing")
        try:
            return json.loads(_read(
                f"https://data.alpaca.markets{path}",
                params=params,
                headers={
                    "APCA-API-KEY-ID": key_id,
                    "APCA-API-SECRET-KEY": secret_key,
                },
                timeout=self.timeout,
            ))
        except HTTPError as error:
            if error.code == 401:
                raise RuntimeError("alpaca_authentication_failed") from error
            if error.code in {403, 422}:
                raise RuntimeError("alpaca_entitlement_denied") from error
            if error.code == 429:
                raise RuntimeError("alpaca_rate_limited") from error
            raise RuntimeError("alpaca_provider_error") from error


class AlpacaQuoteSource(AlpacaSource):
    def fetch(self, symbol: str) -> Quote:
        data = self.read(f"/v2/stocks/{symbol}/trades/latest", params={"feed": self.feed})
        trade = data.get("trade") if isinstance(data, dict) else None
        if not isinstance(data, dict) or data.get("symbol") != symbol or not isinstance(trade, dict):
            raise ValueError("invalid_alpaca_trade")
        observed_at = _parse_provider_datetime(trade["t"])
        return Quote(
            price=float(trade["p"]), observed_at=observed_at,
            source_reference=f"https://data.alpaca.markets/v2/stocks/{symbol}/trades/latest?feed={self.feed}",
        )


class AlpacaHistorySource(AlpacaSource):
    def fetch(self, symbol: str) -> List[DailyBar]:
        now = datetime.now(timezone.utc)
        return self.fetch_range(symbol, (now.date() - timedelta(days=365)).isoformat(), now.date().isoformat())

    def fetch_range(self, symbol: str, start_date: str, end_date: str) -> List[DailyBar]:
        params = {
            "timeframe": "1Day", "start": start_date,
            "end": end_date, "limit": 10000, "adjustment": "all",
            "feed": self.feed, "sort": "asc",
        }
        result, page_tokens = [], set()
        while True:
            data = self.read(f"/v2/stocks/{symbol}/bars", params=params)
            records = data.get("bars") if isinstance(data, dict) else None
            if not isinstance(records, list):
                raise ValueError("invalid_alpaca_history")
            for item in records:
                if not isinstance(item, dict):
                    raise ValueError("invalid_alpaca_history")
                result.append(DailyBar(
                    date=_parse_provider_datetime(item["t"]).date().isoformat(),
                    open=float(item["o"]), high=float(item["h"]), low=float(item["l"]),
                    close=float(item["c"]), volume=float(item["v"]),
                ))
            page_token = data.get("next_page_token")
            if not page_token:
                break
            if not isinstance(page_token, str) or page_token in page_tokens:
                raise ValueError("invalid_alpaca_history_page_token")
            page_tokens.add(page_token)
            params["page_token"] = page_token
        if not result:
            raise ValueError("empty_alpaca_history")
        return result


class AlpacaNewsSource(AlpacaSource):
    def fetch(self, symbol: str) -> List[NewsItem]:
        now, result, page_token, page_tokens = datetime.now(timezone.utc), [], None, set()
        while len(result) < 30:
            params = {
                "symbols": symbol, "start": (now - timedelta(days=30)).isoformat(),
                "end": now.isoformat(), "sort": "desc", "limit": 50, "include_content": "false",
            }
            if page_token:
                params["page_token"] = page_token
            data = self.read("/v1beta1/news", params=params)
            records = data.get("news") if isinstance(data, dict) else None
            if not isinstance(records, list):
                raise ValueError("invalid_alpaca_news")
            for item in records:
                if not isinstance(item, dict) or not item.get("headline") or not item.get("url"):
                    raise ValueError("invalid_alpaca_news")
                symbols = item.get("symbols")
                if not isinstance(symbols, list):
                    raise ValueError("invalid_alpaca_news")
                result.append(NewsItem(
                    title=item["headline"], source=item.get("source") or "Alpaca News",
                    published_at=_parse_provider_datetime(item["created_at"]),
                    fetched_at=now, url=item["url"], summary=str(item.get("summary") or item["headline"])[:500],
                    symbols=symbols,
                ))
            page_token = data.get("next_page_token")
            if not page_token:
                break
            if not isinstance(page_token, str) or page_token in page_tokens:
                raise ValueError("invalid_alpaca_news_page_token")
            page_tokens.add(page_token)
        return result[:30]


class SinaQuoteSource(TimedSource):
    name = "sina"

    def fetch(self, symbol: str) -> Quote:
        raw = _read(
            f"https://hq.sinajs.cn/list=gb_{symbol.lower()}",
            headers={"Referer": "https://finance.sina.com.cn/"},
            timeout=self.timeout,
        ).decode("gbk", errors="replace")
        match = re.search(r'"(.+)"', raw)
        fields = match.group(1).split(",") if match else []
        if len(fields) < 27 or not fields[1]:
            raise ValueError("invalid_sina_quote")
        observed_at = datetime.strptime(fields[3], "%Y-%m-%d %H:%M:%S").replace(
            tzinfo=ZoneInfo("America/New_York"),
        ).astimezone(timezone.utc)
        return Quote(
            price=float(fields[1]), observed_at=observed_at,
            source_reference=f"https://finance.sina.com.cn/stock/usstock/quotes/{symbol}.html",
        )


class TencentQuoteSource(TimedSource):
    name = "tencent"

    def fetch(self, symbol: str) -> Quote:
        raw = _read(f"https://qt.gtimg.cn/q=us{symbol}", timeout=self.timeout).decode("gbk", errors="replace")
        match = re.search(r'"(.+)"', raw)
        fields = match.group(1).split("~") if match else []
        if len(fields) < 36 or not fields[3]:
            raise ValueError("invalid_tencent_quote")
        observed_at = datetime.strptime(fields[30], "%Y-%m-%d %H:%M:%S").replace(
            tzinfo=ZoneInfo("America/New_York"),
        ).astimezone(timezone.utc)
        return Quote(
            price=float(fields[3]), observed_at=observed_at,
            source_reference=f"https://gu.qq.com/us{symbol}",
        )


class SinaHistorySource(TimedSource):
    name = "sina"

    def fetch(self, symbol: str) -> List[DailyBar]:
        raw = _read(
            "https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var/US_MinKService.getDailyK",
            params={"symbol": symbol, "num": 180},
            headers={"Referer": "https://finance.sina.com.cn/"},
            timeout=self.timeout,
        ).decode()
        match = re.search(r"\((\[.+\])\)", raw)
        if not match:
            raise ValueError("invalid_sina_history")
        return [DailyBar(date=item["d"], open=float(item["o"]), high=float(item["h"]),
                         low=float(item["l"]), close=float(item["c"]), volume=float(item["v"]))
                for item in json.loads(match.group(1))[-180:]]

    def fetch_range(self, symbol: str, start_date: str, end_date: str) -> List[DailyBar]:
        return [bar for bar in self.fetch(symbol) if start_date <= bar.date <= end_date]


class YahooHistorySource(TimedSource):
    name = "yahoo"

    def fetch(self, symbol: str) -> List[DailyBar]:
        now = datetime.now(timezone.utc)
        return self.fetch_range(symbol, (now.date() - timedelta(days=365)).isoformat(), now.date().isoformat())

    def fetch_range(self, symbol: str, start_date: str, end_date: str) -> List[DailyBar]:
        period1 = int(datetime.fromisoformat(start_date).replace(tzinfo=timezone.utc).timestamp())
        period2 = int((datetime.fromisoformat(end_date).replace(tzinfo=timezone.utc) + timedelta(days=1)).timestamp())
        data = json.loads(_read(
            f"https://query2.finance.yahoo.com/v8/finance/chart/{symbol}",
            params={"interval": "1d", "period1": period1, "period2": period2},
            timeout=self.timeout,
        ))
        chart = data["chart"]["result"][0]
        quote = chart["indicators"]["quote"][0]
        result = []
        for index, timestamp in enumerate(chart["timestamp"]):
            values = [quote[key][index] for key in ("open", "high", "low", "close", "volume")]
            if any(value is None for value in values):
                continue
            result.append(DailyBar(
                date=datetime.fromtimestamp(timestamp, timezone.utc).date().isoformat(),
                open=values[0], high=values[1], low=values[2], close=values[3], volume=values[4],
            ))
        if not result:
            raise ValueError("empty_yahoo_history")
        return result


class YahooNewsSource(TimedSource):
    name = "yahoo"

    def fetch(self, symbol: str) -> List[NewsItem]:
        data = json.loads(_read(
            "https://query2.finance.yahoo.com/v1/finance/search",
            params={"q": symbol, "quotesCount": 0, "newsCount": 20},
            timeout=self.timeout,
        ))
        now = datetime.now(timezone.utc)
        return [NewsItem(
            title=item["title"], source=item.get("publisher") or "Yahoo Finance",
            published_at=datetime.fromtimestamp(item["providerPublishTime"], timezone.utc),
            fetched_at=now, url=item["link"], summary=item.get("title", "")[:500], symbols=[symbol],
        ) for item in data.get("news", []) if item.get("title") and item.get("link")]


class GoogleNewsSource(TimedSource):
    name = "google-news"

    def fetch(self, symbol: str) -> List[NewsItem]:
        raw = _read("https://news.google.com/rss/search", params={
            "q": f"{symbol} stock", "hl": "en-US", "gl": "US", "ceid": "US:en",
        }, timeout=self.timeout)
        now, result = datetime.now(timezone.utc), []
        for item in ElementTree.fromstring(raw).findall("./channel/item"):
            title, link, published = item.findtext("title"), item.findtext("link"), item.findtext("pubDate")
            if title and link and published:
                result.append(NewsItem(
                    title=title, source="Google News", published_at=parsedate_to_datetime(published),
                    fetched_at=now, url=link, summary=title[:500], symbols=[symbol],
                ))
        return result


class SecFundamentalsSource(TimedSource):
    name = "sec"

    def fetch(self, symbol: str):
        user_agent = os.getenv("SEC_USER_AGENT")
        if not user_agent:
            raise RuntimeError("SEC_USER_AGENT_missing")
        mapping = json.loads(_read(
            "https://www.sec.gov/files/company_tickers.json", headers={"User-Agent": user_agent}, timeout=self.timeout,
        ))
        company = next((value for value in mapping.values() if value.get("ticker") == symbol), None)
        if not company:
            raise ValueError("sec_ticker_not_found")
        cik = str(company["cik_str"]).zfill(10)
        facts = json.loads(_read(
            f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json",
            headers={"User-Agent": user_agent, "Accept-Encoding": "gzip, deflate"},
            timeout=self.timeout,
        ))
        gaap = facts.get("facts", {}).get("us-gaap", {})
        return {
            "company": facts.get("entityName"), "cik": cik,
            **build_financials(
                symbol, gaap, f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json",
            ),
        }


class SecFilingSource(TimedSource):
    name = "sec"

    def _recent(self, symbol: str):
        user_agent = os.getenv("SEC_USER_AGENT")
        if not user_agent:
            raise RuntimeError("SEC_USER_AGENT_missing")
        headers = {"User-Agent": user_agent, "Accept-Encoding": "gzip, deflate"}
        mapping = json.loads(_read(
            "https://www.sec.gov/files/company_tickers.json", headers=headers, timeout=self.timeout,
        ))
        company = next((value for value in mapping.values() if value.get("ticker") == symbol), None)
        if not company:
            raise ValueError("sec_ticker_not_found")
        cik = str(company["cik_str"]).zfill(10)
        submissions = json.loads(_read(
            f"https://data.sec.gov/submissions/CIK{cik}.json", headers=headers, timeout=self.timeout,
        ))
        return cik, submissions.get("filings", {}).get("recent", {})

    def fetch(self, symbol: str, filing_id: str):
        cik, recent = self._recent(symbol)
        accessions = recent.get("accessionNumber", [])
        try:
            index = accessions.index(filing_id)
            form = recent["form"][index]
            filed_at = recent["filingDate"][index]
            primary_document = recent["primaryDocument"][index]
        except (ValueError, IndexError, KeyError) as error:
            raise ValueError("filing_not_found") from error
        accession_path = filing_id.replace("-", "")
        source_reference = (
            f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession_path}/{primary_document}"
        )
        return {
            "filingId": filing_id, "form": form, "filedAt": filed_at,
            "sourceReference": source_reference,
        }

    def fetch_page(self, filing: dict, cursor: str = None):
        offset = int(cursor or "0")
        page = read_document_page(
            filing["sourceReference"], offset, 65536, timeout=min(self.timeout, 10),
        )
        payload = page.pop("payload")
        text = " ".join(re.sub(r"<[^>]+>", " ", payload.decode("utf-8", errors="replace")).split())
        if not text or not isinstance(page.get("totalBytes"), int):
            raise ValueError("filing_page_not_qualifiable")
        return {
            **filing, **page, "summary": text[:500], "contentHash": sha256(payload).hexdigest(),
        }

    def list_events(self, symbol: str):
        cik, recent = self._recent(symbol)
        supported = {"10-K": "earnings", "10-Q": "earnings", "8-K": "company_event", "S-3": "dilution"}
        events = []
        for filing_id, form, filed_at, primary_document in zip(
            recent.get("accessionNumber", []), recent.get("form", []),
            recent.get("filingDate", []), recent.get("primaryDocument", []),
        ):
            if form not in supported:
                continue
            events.append({
                "filingId": filing_id, "form": form, "filedAt": filed_at,
                "eventType": supported[form],
                "sourceReference": (
                    f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/"
                    f"{filing_id.replace('-', '')}/{primary_document}"
                ),
            })
            if len(events) >= 20:
                break
        return events


COMPARABLES = {
    "NVDA": ("semiconductor", ["AMD", "AVGO", "QCOM"]),
    "AMD": ("semiconductor", ["NVDA", "AVGO", "QCOM"]),
    "AVGO": ("semiconductor", ["NVDA", "AMD", "QCOM"]),
    "QCOM": ("semiconductor", ["NVDA", "AMD", "AVGO"]),
    "SNDK": ("semiconductor", ["MU", "WDC", "STX"]),
    "CRM": ("saas", ["NOW", "ADBE", "ORCL"]),
    "NOW": ("saas", ["CRM", "ADBE", "ORCL"]),
    "ADBE": ("saas", ["CRM", "NOW", "ORCL"]),
    "ORCL": ("saas", ["CRM", "NOW", "ADBE"]),
}


class YahooValuationSource(TimedSource):
    name = "yahoo-timeseries"

    def fetch(self, symbol: str):
        return self.fetch_with_market_price(symbol, None, None)

    def fetch_with_market_price(self, symbol: str, market_price, market_price_observed_at):
        industry_and_peers = COMPARABLES.get(symbol)
        if not industry_and_peers:
            company = self._metrics(symbol)
            input_observed_at = {
                **({"marketPrice": market_price_observed_at} if market_price_observed_at else {}),
                **{f"company.{key}": value for key, value in company.get("observedAt", {}).items()},
                **{
                    f"company.historicalPe.{index}": item["observedAt"]
                    for index, item in enumerate(company.get("historicalPe", []))
                },
            }
            return calculate_valuation(ValuationInput(
                symbol=symbol, industry="unsupported", current_price=market_price or 0,
                diluted_eps=company.get("dilutedEps"), enterprise_value=company.get("enterpriseValue"),
                ebitda=company.get("ebitda"), revenue=company.get("revenue"), comparables=[],
                historical_multiples={
                    "pe": [item["value"] for item in company.get("historicalPe", [])],
                },
                input_observed_at=input_observed_at,
                source=self.name, as_of=market_price_observed_at,
            ))
        industry, peers = industry_and_peers
        company = self._metrics(symbol)
        comparables = []
        peer_observed_at = {}
        for peer in peers:
            values = self._metrics(peer)
            peer_observed_at.update({
                f"comparables.{peer}.{key}": value
                for key, value in values.get("observedAt", {}).items()
            })
            comparables.append({
                "symbol": peer, "pe": values.get("pe"),
                "evToEbitda": _ratio(values.get("enterpriseValue"), values.get("ebitda")),
                "evToRevenue": _ratio(values.get("enterpriseValue"), values.get("revenue")),
            })
        return calculate_valuation(ValuationInput(
            symbol=symbol, industry=industry,
            current_price=market_price or 0,
            diluted_eps=company.get("dilutedEps"), enterprise_value=company.get("enterpriseValue"),
            ebitda=company.get("ebitda"), revenue=company.get("revenue"),
            comparables=comparables,
            historical_multiples={
                "pe": [item["value"] for item in company.get("historicalPe", [])],
            },
            input_observed_at={
                **({"marketPrice": market_price_observed_at} if market_price_observed_at else {}),
                **{f"company.{key}": value for key, value in company.get("observedAt", {}).items()},
                **{
                    f"company.historicalPe.{index}": item["observedAt"]
                    for index, item in enumerate(company.get("historicalPe", []))
                },
                **peer_observed_at,
            },
            source=self.name,
            as_of=market_price_observed_at or max(
                [*company.get("observedAt", {}).values(), *peer_observed_at.values()], default=None,
            ),
        ))

    def _metrics(self, symbol: str):
        now = int(datetime.now(timezone.utc).timestamp())
        data = json.loads(_read(
            f"https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/{symbol}",
            params={
                "symbol": symbol,
                "type": "trailingDilutedEPS,trailingPeRatio,trailingEnterpriseValue,trailingEBITDA,trailingTotalRevenue",
                "merge": "false", "period1": now - 366 * 24 * 60 * 60, "period2": now,
            },
            timeout=self.timeout,
        ))
        mapped = {}
        keys = {
            "trailingDilutedEPS": "dilutedEps", "trailingPeRatio": "pe",
            "trailingEnterpriseValue": "enterpriseValue", "trailingEBITDA": "ebitda",
            "trailingTotalRevenue": "revenue",
        }
        for series in data.get("timeseries", {}).get("result", []):
            source_key = (series.get("meta", {}).get("type") or [None])[0]
            values = series.get(source_key, [])
            if source_key == "trailingPeRatio":
                mapped["historicalPe"] = [{
                    "value": item["reportedValue"]["raw"], "observedAt": item["asOfDate"],
                } for item in values if item.get("reportedValue") and item.get("asOfDate")]
            if values and source_key in keys:
                mapped[keys[source_key]] = values[-1]["reportedValue"]["raw"]
                observed_at = values[-1].get("asOfDate")
                if observed_at:
                    mapped.setdefault("observedAt", {})[keys[source_key]] = observed_at
        return mapped


def _ratio(numerator, denominator):
    return numerator / denominator if numerator and denominator else None


def _parse_provider_datetime(value) -> datetime:
    """Parse RFC 3339 timestamps while truncating provider nanoseconds to Python microseconds."""
    text = str(value).replace("Z", "+00:00")
    match = re.match(r"^(.*\.)(\d+)([+-]\d\d:\d\d)$", text)
    if match:
        text = f"{match.group(1)}{match.group(2)[:6]}{match.group(3)}"
    return datetime.fromisoformat(text)

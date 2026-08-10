import time
from datetime import datetime

import firebase_admin
import requests
from bs4 import BeautifulSoup
from firebase_functions import https_fn
from recipe_scrapers import scrape_html

firebase_admin.initialize_app()


HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0",
}


@https_fn.on_call(invoker="public", region="us-west1")
def scrape_recipe(req: https_fn.CallableRequest) -> dict:
    url = req.data.get("url", "").strip()
    if not url:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            message="url is required",
        )

    try:
        session = requests.Session()
        session.headers.update(HEADERS)
        response = session.get(url, timeout=15, allow_redirects=True)
        html = response.text
    except Exception as e:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.UNAVAILABLE,
            message=f"Could not fetch URL: {e}",
        )

    try:
        scraper = scrape_html(html, org_url=url, wild_mode=True)
    except Exception as e:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.NOT_FOUND,
            message=f"Could not find recipe on page: {e}",
        )

    def safe(fn):
        try:
            return fn()
        except Exception:
            return None

    return {
        "title": safe(scraper.title) or "",
        "host": safe(scraper.host) or "",
        "source": safe(scraper.host) or "",
        "ingredients": safe(scraper.ingredients) or [],
        "instructions": (safe(scraper.instructions_list) or
                         [s.strip() for s in (safe(scraper.instructions) or "").split("\n") if s.strip()]),
        "prepTime": safe(scraper.prep_time),
        "cookTime": safe(scraper.cook_time),
        "totalTime": safe(scraper.total_time),
        "servings": safe(scraper.yields),
        "image": safe(scraper.image),
    }


# ─── S&P 500 Market Data ─────────────────────────────────────────────────────

METRIC_URLS = {
    "trailing": "https://www.multpl.com/s-p-500-pe-ratio/table/by-month",
    "cape": "https://www.multpl.com/shiller-pe/table/by-month",
    "earnings": "https://www.multpl.com/s-p-500-earnings/table/by-month",
}

_metric_cache = {}
METRIC_CACHE_TTL = 24 * 60 * 60  # 24 hours


def _scrape_multpl_table(url):
    """Fetch and parse a numeric table from multpl.com.

    Returns a list of {"date": "YYYY-MM-DD", "value": float} sorted by date.
    Handles plain numbers, percentages, and dollar amounts.
    """
    session = requests.Session()
    session.headers.update(HEADERS)
    response = session.get(url, timeout=15)
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")
    table = soup.find("table", id="datatable")
    if not table:
        raise ValueError("Could not find data table on page")

    data = []
    for row in table.find_all("tr"):
        cells = row.find_all("td")
        if len(cells) < 2:
            continue
        date_str = cells[0].get_text(strip=True)
        val_str = cells[1].get_text(strip=True)
        # Remove estimate marker, whitespace chars, $, %
        val_str = (
            val_str.replace("\u2020", "")
            .replace("\u2002", "")
            .replace("$", "")
            .replace("%", "")
            .replace(",", "")
            .strip()
        )
        try:
            value = float(val_str)
            dt = datetime.strptime(date_str, "%b %d, %Y")
            data.append({"date": dt.strftime("%Y-%m-%d"), "value": round(value, 2)})
        except (ValueError, TypeError):
            continue

    data.sort(key=lambda d: d["date"])
    return data


def _compute_yoy_growth(raw_data):
    """Compute year-over-year growth rate from monthly raw values.

    For each data point, finds the value ~12 months prior and computes
    the percentage change. Returns the same format with growth rate as value.
    """
    # Build a lookup by (year, month) for fast matching
    by_month = {}
    for d in raw_data:
        parts = d["date"].split("-")
        key = (int(parts[0]), int(parts[1]))
        by_month[key] = d["value"]

    growth = []
    for d in raw_data:
        parts = d["date"].split("-")
        y, m = int(parts[0]), int(parts[1])
        prior_key = (y - 1, m)
        if prior_key in by_month and by_month[prior_key] != 0:
            pct = ((d["value"] - by_month[prior_key]) / abs(by_month[prior_key])) * 100
            growth.append({"date": d["date"], "value": round(pct, 2)})

    return growth


@https_fn.on_call(invoker="public", region="us-west1")
def fetch_pe_data(req: https_fn.CallableRequest) -> dict:
    metric = req.data.get("type", "trailing") if req.data else "trailing"
    if metric not in METRIC_URLS:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            message=f"type must be one of: {', '.join(METRIC_URLS.keys())}",
        )

    now = time.time()
    cached = _metric_cache.get(metric)
    if cached and (now - cached["timestamp"]) < METRIC_CACHE_TTL:
        return cached["result"]

    try:
        raw = _scrape_multpl_table(METRIC_URLS[metric])
        if metric == "earnings":
            # Convert raw earnings to YoY growth rate
            data = _compute_yoy_growth(raw)
        else:
            data = raw
    except Exception as e:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.UNAVAILABLE,
            message=f"Could not fetch data: {e}",
        )

    result = {"data": data, "type": metric}
    _metric_cache[metric] = {"result": result, "timestamp": now}
    return result

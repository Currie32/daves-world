import firebase_admin
import requests
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

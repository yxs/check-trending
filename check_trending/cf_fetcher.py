"""Cloudflare-aware fetcher for main.php monthly listings.

Checkee.info gates ``main.php?dispdate=YYYY-MM`` behind a Cloudflare managed
JS challenge. urllib / requests / curl_cffi cannot solve it because the
challenge enforces JS execution and a real Chrome browser fingerprint.

This module wraps `patchright` (a stealth fork of Playwright) running headed
against the system Chrome. On CI it pairs with ``xvfb-run`` to provide a
virtual display. Detail pages are not gated and continue to use the plain
urllib-based ``PoliteHttpClient``.
"""
from __future__ import annotations

from typing import Any


CHALLENGE_TITLE_FRAGMENT = "Just a moment"


class BrowserFetcher:
    """Maintains a single patchright browser session across multiple URL fetches.

    Designed to be used as a context manager so the browser is launched once
    per scraper run and closed cleanly even on failure::

        with BrowserFetcher() as fetcher:
            html = fetcher.fetch(url)
    """

    def __init__(
        self,
        *,
        channel: str | None = None,
        headless: bool = False,
        viewport_width: int = 1280,
        viewport_height: int = 800,
        locale: str = "en-US",
        navigation_timeout_ms: int = 60_000,
        challenge_wait_ms: int = 60_000,
    ) -> None:
        self.channel = channel
        self.headless = headless
        self.viewport = {"width": viewport_width, "height": viewport_height}
        self.locale = locale
        self.navigation_timeout_ms = navigation_timeout_ms
        self.challenge_wait_ms = challenge_wait_ms
        self._playwright: Any = None
        self._browser: Any = None
        self._context: Any = None
        self._page: Any = None

    def start(self) -> None:
        try:
            from patchright.sync_api import sync_playwright
        except ImportError as error:
            raise RuntimeError(
                "patchright is not installed. Install it via "
                "`pip install patchright` (and on Linux CI pair with "
                "`xvfb-run` so the headed browser has a display)."
            ) from error

        self._playwright = sync_playwright().start()
        launch_kwargs: dict[str, Any] = {"headless": self.headless}
        if self.channel:
            launch_kwargs["channel"] = self.channel
        self._browser = self._playwright.chromium.launch(**launch_kwargs)
        self._context = self._browser.new_context(
            locale=self.locale, viewport=self.viewport
        )
        self._page = self._context.new_page()

    def stop(self) -> None:
        try:
            if self._browser is not None:
                self._browser.close()
        finally:
            self._browser = None
            self._context = None
            self._page = None
            if self._playwright is not None:
                try:
                    self._playwright.stop()
                finally:
                    self._playwright = None

    def fetch(self, url: str) -> str:
        if self._page is None:
            self.start()
        assert self._page is not None
        page = self._page

        try:
            page.goto(url, wait_until="domcontentloaded", timeout=self.navigation_timeout_ms)
        except Exception as error:  # noqa: BLE001
            raise RuntimeError(f"browser navigation failed for {url}: {error}") from error

        try:
            page.wait_for_function(
                f"!document.title.includes('{CHALLENGE_TITLE_FRAGMENT}')",
                timeout=self.challenge_wait_ms,
            )
        except Exception as error:  # noqa: BLE001
            title = page.title() or ""
            if CHALLENGE_TITLE_FRAGMENT in title:
                raise RuntimeError(
                    f"Cloudflare challenge did not resolve within "
                    f"{self.challenge_wait_ms}ms for {url}"
                ) from error
            # Title cleared during the small race window — fall through to read content.

        return page.content()

    def __enter__(self) -> "BrowserFetcher":
        self.start()
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> bool:
        self.stop()
        return False

"""Cloudflare-aware fetcher for main.php monthly listings."""
from __future__ import annotations

from typing import Any


CHALLENGE_TITLE_FRAGMENT = "Just a moment"


class BrowserFetcher:
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
                "patchright is not installed. Run: "
                "`pip install patchright && patchright install chromium --no-shell`"
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
            page.goto(
                url, wait_until="domcontentloaded", timeout=self.navigation_timeout_ms
            )
        except Exception as error:
            raise RuntimeError(f"browser navigation failed for {url}: {error}") from error

        try:
            page.wait_for_function(
                f"!document.title.includes('{CHALLENGE_TITLE_FRAGMENT}')",
                timeout=self.challenge_wait_ms,
            )
        except Exception as error:
            title = page.title() or ""
            if CHALLENGE_TITLE_FRAGMENT in title:
                raise RuntimeError(
                    f"Cloudflare challenge did not resolve within "
                    f"{self.challenge_wait_ms}ms for {url}"
                ) from error

        return page.content()

    def __enter__(self) -> "BrowserFetcher":
        self.start()
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> bool:
        self.stop()
        return False

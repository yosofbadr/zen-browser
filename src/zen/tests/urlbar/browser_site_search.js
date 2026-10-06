/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  UrlbarTestUtils: "resource://testing-common/UrlbarTestUtils.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  SessionSaver:
    "moz-src:///browser/components/sessionstore/SessionSaver.sys.mjs",
  TabStateFlusher:
    "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs",
  ZenUrlbarProviderSiteSearch:
    "resource:///modules/ZenUBSiteSearchProvider.sys.mjs",
});

async function siteSearchRow(value) {
  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    waitForFocus,
    value,
  });
  for (let index = 0; index < UrlbarTestUtils.getResultCount(window); index++) {
    const row = await UrlbarTestUtils.getRowAt(window, index);
    if (row.result.providerName == "ZenUrlbarProviderSiteSearch") {
      return { row, index };
    }
  }
  return null;
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["zen.urlbar.site-search.enabled", true],
      ["browser.urlbar.suggest.engines", true],
    ],
  });
  await window.gZenSiteSearch.ready;
  registerCleanupFunction(async () => {
    await gURLBar.setSearchMode(null, gBrowser.selectedBrowser);
    await UrlbarTestUtils.promisePopupClose(window);
  });
});

add_task(async function test_normal_suggestion_and_enter_action() {
  const match = await siteSearchRow("yout");
  Assert.ok(match, "A normal site prefix offers site search");
  Assert.equal(
    SearchService.visibleEngines.filter(engine => engine.name == "YouTube")
      .length,
    1,
    "Default installation does not duplicate native engines"
  );
  Assert.equal(match.row.result.payload.title, "YouTube");
  Assert.equal(
    match.row.querySelector(".urlbarView-action").textContent,
    "Search YouTube",
    "The action explains what Enter will do"
  );
  Assert.greater(match.index, 0, "The ordinary heuristic remains available");
  Assert.equal(
    match.row.querySelectorAll('[role="button"]').length,
    0,
    "The search action adds no extra stop to Tab navigation"
  );
  const engine = SearchService.getEngineByName(match.row.result.payload.engine);
  const query = "rust & café #1";
  const submission = new URL(engine.getSubmission(query).uri.spec);
  Assert.equal(
    submission.searchParams.get("search_query"),
    query,
    "Native submission encodes the query correctly"
  );
  UrlbarTestUtils.setSelectedRowIndex(window, match.index);
  Assert.equal(
    gURLBar.value,
    "youtube.com",
    "Selecting the site shows its domain"
  );
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(
    () => gURLBar.searchMode?.engineName == match.row.result.payload.engine
  );
  Assert.equal(
    gURLBar.value,
    "",
    "Entering site search clears the site prefix"
  );
  await new Promise(resolve => requestAnimationFrame(resolve));
  await new Promise(resolve => requestAnimationFrame(resolve));
  Assert.ok(gURLBar.view.isOpen, "Site search keeps the suggestions open");
  Assert.ok(
    gURLBar.hasAttribute("zen-site-search"),
    "The site pill receives its styling"
  );
  await gURLBar.setSearchMode(null, gBrowser.selectedBrowser);
  Assert.ok(
    !gURLBar.hasAttribute("zen-site-search"),
    "Leaving search mode clears the styling"
  );
  await UrlbarTestUtils.promisePopupClose(window);
});

add_task(async function test_click_search_action() {
  const match = await siteSearchRow("youtube");
  const action = match.row.querySelector(".urlbarView-action");
  Assert.ok(action, "Search action is rendered beside the result");
  Assert.equal(
    action.textContent,
    "Search YouTube",
    "The action names the supported site"
  );
  EventUtils.synthesizeMouseAtCenter(action, {});
  await TestUtils.waitForCondition(
    () => gURLBar.searchMode?.engineName == match.row.result.payload.engine
  );
  Assert.equal(gURLBar.value, "");
  await gURLBar.setSearchMode(null, gBrowser.selectedBrowser);
  await UrlbarTestUtils.promisePopupClose(window);
});

add_task(async function test_click_site_row() {
  const match = await siteSearchRow("youtube");
  EventUtils.synthesizeMouseAtCenter(
    match.row.querySelector(".urlbarView-title"),
    {}
  );
  await TestUtils.waitForCondition(
    () => gURLBar.searchMode?.engineName == match.row.result.payload.engine
  );
  Assert.equal(gURLBar.value, "", "Clicking the row enters search mode");
  await gURLBar.setSearchMode(null, gBrowser.selectedBrowser);
  await UrlbarTestUtils.promisePopupClose(window);
});

add_task(async function test_no_shorthand_and_disabled_pref() {
  for (const value of ["yt", "gh", "youtube tutorials"]) {
    Assert.equal(
      await siteSearchRow(value),
      null,
      "Only site names and domains match"
    );
    await UrlbarTestUtils.promisePopupClose(window);
  }
  await SpecialPowers.pushPrefEnv({
    set: [["zen.urlbar.site-search.enabled", false]],
  });
  Assert.equal(
    await siteSearchRow("youtube"),
    null,
    "The preference disables site suggestions"
  );
  await UrlbarTestUtils.promisePopupClose(window);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_unsupported_installed_engine() {
  const engine = await SearchService.addUserEngine({
    name: "Unsupported GitHub",
    url: "https://github.com/search?q={searchTerms}",
  });
  try {
    Assert.equal(
      await siteSearchRow("github"),
      null,
      "An installed non-YouTube engine is not offered by site search"
    );
    Assert.equal(
      SearchService.getEngineByName(engine.name),
      engine,
      "Unsupported engines remain installed for ordinary search"
    );
  } finally {
    await SearchService.removeEngine(engine);
    await UrlbarTestUtils.promisePopupClose(window);
  }
});

add_task(async function test_site_search_and_switch_to_tab_coexist() {
  const tab = BrowserTestUtils.addTab(gBrowser, "https://example.com/");
  try {
    await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
    tab.zenStaticLabel = "YouTube integration video";
    gBrowser._setTabLabel(tab, tab.zenStaticLabel);
    await TabStateFlusher.flushWindow(window);
    await SessionSaver.run();
    const match = await siteSearchRow("youtube");
    Assert.ok(match, "Site search remains available");
    const rows = Array.from(
      UrlbarTestUtils.getResultsContainer(window).children
    );
    Assert.ok(
      rows.some(
        row =>
          row.result?.providerName == "ZenUrlbarProviderSidebar" &&
          row.result.payload.title == tab.zenStaticLabel
      ),
      "Switch to Tab remains available beside site search"
    );
    const tabRow = rows.find(
      row =>
        row.result?.providerName == "ZenUrlbarProviderSidebar" &&
        row.result.payload.title == tab.zenStaticLabel
    );
    const searchAction = match.row.querySelector(".urlbarView-action");
    const tabAction = tabRow.querySelector(".urlbarView-action");
    for (const property of ["fontSize", "fontWeight", "opacity", "scale"]) {
      Assert.equal(
        getComputedStyle(searchAction)[property],
        getComputedStyle(tabAction)[property],
        `Search and Switch to Tab share ${property}`
      );
    }
    Assert.equal(
      getComputedStyle(searchAction, "::after").maskImage,
      getComputedStyle(tabAction, "::after").maskImage,
      "Search uses the existing Switch to Tab arrow"
    );
  } finally {
    await UrlbarTestUtils.promisePopupClose(window);
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_tab_keeps_navigating_suggestions() {
  const match = await siteSearchRow("youtube");
  UrlbarTestUtils.setSelectedRowIndex(window, match.index);
  const selectedElement = gURLBar.view.selectedElement;
  EventUtils.synthesizeKey("KEY_Tab");
  await TestUtils.waitForCondition(
    () => gURLBar.view.selectedElement != selectedElement || gURLBar.searchMode
  );
  Assert.equal(gURLBar.searchMode, null, "Tab must not enter site search");
  Assert.notEqual(
    gURLBar.view.selectedResult?.providerName,
    "ZenUrlbarProviderSiteSearch",
    "Tab moves past the site-search row without an extra action stop"
  );
  UrlbarTestUtils.setSelectedRowIndex(window, match.index);
  EventUtils.synthesizeKey("KEY_Tab", { shiftKey: true });
  Assert.equal(
    gURLBar.view.selectedRowIndex,
    match.index - 1,
    "Shift+Tab moves back to the preceding suggestion"
  );
  Assert.equal(
    gURLBar.searchMode,
    null,
    "Shift+Tab does not enter site search"
  );
  await gURLBar.setSearchMode(null, gBrowser.selectedBrowser);
  await UrlbarTestUtils.promisePopupClose(window);
});

add_task(async function test_custom_engine_name_and_removal() {
  const engine = await SearchService.addUserEngine({
    name: "My video search",
    url: "https://www.youtube.com/results?search_query={searchTerms}",
  });
  try {
    const match = await siteSearchRow("my video");
    Assert.ok(match, "The user's engine name is searchable");
    Assert.equal(match.row.result.payload.title, engine.name);
    UrlbarTestUtils.setSelectedRowIndex(window, match.index);
    await SearchService.removeEngine(engine);
    const value = gURLBar.value;
    await window.gZenSiteSearch.enter(engine.name);
    Assert.equal(gURLBar.searchMode, null, "A removed engine is not activated");
    Assert.equal(gURLBar.value, value, "A stale row does not erase the input");
    await UrlbarTestUtils.promisePopupClose(window);
    Assert.equal(
      await siteSearchRow("my video"),
      null,
      "The removed engine is not offered or recreated"
    );
  } finally {
    if (SearchService.getEngineByName(engine.name)) {
      await SearchService.removeEngine(engine);
    }
    await UrlbarTestUtils.promisePopupClose(window);
  }
});

add_task(async function test_cancel_during_icon_lookup() {
  const provider = new ZenUrlbarProviderSiteSearch();
  provider.queryInstance = {};
  const engine = SearchService.getEngineByName("YouTube");
  const getIconURL = engine.getIconURL;
  const iconStarted = Promise.withResolvers();
  const iconFinished = Promise.withResolvers();
  engine.getIconURL = () => {
    iconStarted.resolve();
    return iconFinished.promise;
  };
  try {
    const results = [];
    const query = provider.startQuery(
      {
        searchString: "youtube",
        restrictInSearchMode: () => false,
      },
      (_provider, result) => results.push(result)
    );
    await iconStarted.promise;
    provider.queryInstance = null;
    iconFinished.resolve(null);
    await query;
    Assert.equal(
      results.length,
      0,
      "A canceled query returns no stale results"
    );
  } finally {
    iconFinished.resolve(null);
    engine.getIconURL = getIconURL;
  }
});

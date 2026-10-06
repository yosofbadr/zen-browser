/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  SITE_SEARCH_DEFAULTS,
  describeSiteSearchEngine,
} from "./ZenSiteSearchRegistry.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  UrlbarShared: "chrome://browser/content/urlbar/UrlbarShared.mjs",
});

const ENABLED_PREF = "zen.urlbar.site-search.enabled";
const INITIALIZED_PREF = "zen.urlbar.site-search.initialized";
export const SITE_SEARCH_PROVIDER_NAME = "ZenUrlbarProviderSiteSearch";
let installPromise;

/** Install defaults once per profile, preserving removals and existing engines. */
async function ensureDefaultEngines() {
  await lazy.SearchService.init();
  if (Services.prefs.getBoolPref(INITIALIZED_PREF, false)) {
    return;
  }
  const engines = await lazy.SearchService.getEngines();
  for (const preset of SITE_SEARCH_DEFAULTS) {
    const existing = engines.some(
      engine => describeSiteSearchEngine(engine, true)?.domain == preset.domain
    );
    if (!existing) {
      // An unrelated engine with the same name must not be replaced.
      let name = preset.name;
      while (lazy.SearchService.getEngineByName(name)) {
        name = `Zen ${name}`;
      }
      await lazy.SearchService.addUserEngine({ name, url: preset.url });
    }
  }
  Services.prefs.setBoolPref(INITIALIZED_PREF, true);
}

/**
 * @returns {Promise<object[]>} Visible engines with site-search presentation.
 */
export async function getSiteSearchProviders() {
  if (!Services.prefs.getBoolPref(ENABLED_PREF, true)) {
    return [];
  }
  installPromise ||= ensureDefaultEngines().catch(error => {
    installPromise = null;
    throw error;
  });
  await installPromise;
  return lazy.SearchService.visibleEngines
    .map(engine => describeSiteSearchEngine(engine))
    .filter(Boolean);
}

/** A window-local interaction layer over Firefox's native search mode. */
export class ZenSiteSearch {
  #window;
  #input;
  #providers = [];
  #destroyed = false;

  constructor(window) {
    this.#window = window;
    this.#input = window.gURLBar;
    // Native dynamic-result engagement reverts/closes the floating urlbar.
    // providesSearchMode avoids that but also previews the mode on Tab.
    // Only intercept picking our row; Firefox still owns result selection.
    this.#input.addEventListener("keydown", this, true);
    this.#input.addEventListener("mouseup", this, true);
    this.#input.addEventListener("searchmodechanged", this);
    window.addEventListener("unload", this, { once: true });
    Services.prefs.addObserver(ENABLED_PREF, this);
    this.ready = this.#initialize();
  }

  async #initialize() {
    try {
      await getSiteSearchProviders();
      if (this.#destroyed) {
        return;
      }
      await this.#input.controller.engineStore.init();
      if (!this.#destroyed) {
        this.#input.controller.engineStore.addObserver(this.#onEngineUpdate);
        this.#onEngineUpdate();
      }
    } catch (error) {
      console.error("Unable to initialize Zen site search", error);
    }
  }

  #onEngineUpdate = () => {
    this.#providers = lazy.SearchService.visibleEngines
      .map(engine => describeSiteSearchEngine(engine))
      .filter(Boolean);
    this.#update();
  };

  observe() {
    this.#update();
    if (Services.prefs.getBoolPref(ENABLED_PREF, true)) {
      getSiteSearchProviders()
        .then(() => {
          if (!this.#destroyed) {
            this.#onEngineUpdate();
          }
        })
        .catch(console.error);
    }
  }

  handleEvent(event) {
    if (event.type == "unload") {
      this.destroy();
      return;
    }
    if (event.type == "searchmodechanged") {
      this.#update();
      return;
    }
    if (!Services.prefs.getBoolPref(ENABLED_PREF, true)) {
      return;
    }
    const view = this.#input.view;
    const result =
      event.type == "mouseup"
        ? view.getResultFromElement(event.target)
        : view.selectedResult;
    if (result?.providerName != SITE_SEARCH_PROVIDER_NAME) {
      return;
    }
    const unmodified =
      !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
    const activate =
      event.type == "mouseup"
        ? event.button == 0 && unmodified
        : unmodified &&
          !event.isComposing &&
          !event.repeat &&
          !view.isResultMenuOpen() &&
          !view.oneOffSearchButtons?.selectedButton &&
          event.key == "Enter";
    if (activate) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.enter(result.payload.engine).catch(console.error);
    }
  }

  /**
   * @param {string} engineName The selected site's installed engine name.
   * @returns {Promise<void>} Resolves once native search mode is entered.
   */
  async enter(engineName) {
    const browser = this.#window.gBrowser.selectedBrowser;
    await this.ready;
    if (
      this.#destroyed ||
      this.#window.gBrowser.selectedBrowser != browser ||
      !Services.prefs.getBoolPref(ENABLED_PREF, true)
    ) {
      return;
    }
    await this.#input.setSearchMode(
      {
        engineName,
        source: lazy.UrlbarShared.RESULT_SOURCE.SEARCH,
        entry: "keywordoffer",
        isPreview: false,
      },
      browser
    );
    if (
      !this.#destroyed &&
      this.#window.gBrowser.selectedBrowser == browser &&
      this.#input.searchMode?.engineName == engineName
    ) {
      this.#input.search("", { focus: true });
      this.#update();
    }
  }

  #update() {
    const mode = this.#input.searchMode;
    const active = Services.prefs.getBoolPref(ENABLED_PREF, true)
      ? this.#providers.find(
          provider => provider.engineName == mode?.engineName
        )
      : null;
    this.#input.toggleAttribute("zen-site-search", !!active);
    if (active) {
      this.#input.style.setProperty("--zen-site-search-accent", active.accent);
    } else {
      this.#input.style.removeProperty("--zen-site-search-accent");
    }
  }

  destroy() {
    this.#destroyed = true;
    this.#input.controller.engineStore.removeObserver(this.#onEngineUpdate);
    Services.prefs.removeObserver(ENABLED_PREF, this);
    this.#input.removeEventListener("keydown", this, true);
    this.#input.removeEventListener("mouseup", this, true);
    this.#input.removeEventListener("searchmodechanged", this);
  }
}

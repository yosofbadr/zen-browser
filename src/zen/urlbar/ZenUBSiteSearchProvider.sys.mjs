/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { UrlbarProvider } from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";
import { UrlbarShared } from "chrome://browser/content/urlbar/UrlbarShared.mjs";
import { UrlbarResult } from "chrome://browser/content/urlbar/UrlbarResult.mjs";
import {
  getSiteSearchProviders,
  SITE_SEARCH_PROVIDER_NAME,
} from "./ZenSiteSearch.sys.mjs";
import { findSiteSearches } from "./ZenSiteSearchRegistry.sys.mjs";

const DYNAMIC_TYPE = "zen-site-search";
const lazy = {};
ChromeUtils.defineLazyGetter(
  lazy,
  "l10n",
  () => new Localization(["browser/zen-general.ftl"], true)
);
ChromeUtils.defineESModuleGetters(lazy, {
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
});

export class ZenUrlbarProviderSiteSearch extends UrlbarProvider {
  get name() {
    return SITE_SEARCH_PROVIDER_NAME;
  }

  get type() {
    return UrlbarShared.PROVIDER_TYPE.PROFILE;
  }

  async isActive(context) {
    return (
      Services.prefs.getBoolPref("zen.urlbar.site-search.enabled", true) &&
      Services.prefs.getBoolPref("browser.urlbar.suggest.engines", true) &&
      !!context.searchString.trim() &&
      !context.searchMode &&
      !context.restrictSource &&
      !context.restrictInSearchMode()
    );
  }

  async startQuery(context, addCallback) {
    const instance = this.queryInstance;
    const providers = await getSiteSearchProviders();
    if (instance != this.queryInstance) {
      return;
    }
    const matches = findSiteSearches(context.searchString, providers).slice(
      0,
      3
    );
    for (const [index, provider] of matches.entries()) {
      const engine = lazy.SearchService.getEngineByName(provider.engineName);
      if (!engine || engine.hidden) {
        continue;
      }
      const icon = await engine.getIconURL();
      if (!(await this.isActive(context)) || instance != this.queryInstance) {
        return;
      }
      addCallback(
        this,
        new UrlbarResult({
          type: UrlbarShared.RESULT_TYPE.DYNAMIC,
          source: UrlbarShared.RESULT_SOURCE.OTHER_LOCAL,
          suggestedIndex: 1 + index,
          payload: {
            dynamicType: DYNAMIC_TYPE,
            engine: provider.engineName,
            title: provider.name,
            domain: provider.domain,
            input: provider.domain,
            url: provider.homepage,
            icon: icon || UrlbarShared.getIconForUrl(provider.homepage),
          },
        })
      );
    }
  }

  getViewTemplate() {
    return {
      attributes: { selectable: true },
      children: [
        { name: "icon", tag: "img", classList: ["urlbarView-favicon"] },
        {
          name: "title",
          tag: "span",
          classList: ["urlbarView-title"],
        },
        {
          name: "separator",
          tag: "span",
          classList: ["urlbarView-title-separator"],
        },
        {
          name: "domain",
          tag: "span",
          classList: ["urlbarView-url"],
        },
        {
          name: "action",
          tag: "span",
          classList: ["urlbarView-action"],
        },
      ],
    };
  }

  getViewUpdate(result) {
    return {
      icon: { attributes: { src: result.payload.icon } },
      title: { textContent: result.payload.title },
      domain: { textContent: result.payload.domain },
      action: {
        textContent: lazy.l10n.formatValueSync("zen-site-search-hint", {
          name: result.payload.title,
        }),
      },
    };
  }
}

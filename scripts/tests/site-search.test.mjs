/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

import assert from "node:assert/strict";
import test from "node:test";
import {
  SITE_SEARCH_DEFAULTS,
  findSiteSearches,
  describeSiteSearchEngine,
} from "../../src/zen/urlbar/ZenSiteSearchRegistry.sys.mjs";

const names = query =>
  findSiteSearches(query, SITE_SEARCH_DEFAULTS).map(p => p.name);

test("ordinary site prefixes and domains need no aliases", () => {
  for (const query of [
    "yo",
    "yout",
    " YouTube ",
    "youtube.com",
    "www.youtube.com",
  ]) {
    assert.deepEqual(names(query), ["YouTube"]);
  }
  for (const query of [
    "github",
    "git",
    "reddit",
    "stack ov",
    "developer.mozilla",
    "spotify",
    "yt",
    "gh",
    "youtube tutorials",
    "",
    "https://youtube.com",
    "youtube.com/watch",
    "@youtube",
    "co",
    "org",
  ]) {
    assert.deepEqual(names(query), [], query);
  }
});

test("YouTube is the only built-in site", () => {
  assert.equal(SITE_SEARCH_DEFAULTS.length, 1);
  assert.equal(SITE_SEARCH_DEFAULTS[0].domain, "youtube.com");
});

test("installed engines keep their identity and native submission", () => {
  const engine = {
    name: "My video search",
    getSubmission: () => ({
      uri: { spec: "https://www.youtube.com/results?search_query=" },
      postData: {},
    }),
  };
  const provider = describeSiteSearchEngine(engine);
  assert.equal(provider.name, engine.name);
  assert.equal(provider.engineName, engine.name);
  assert.equal(provider.domain, "youtube.com");
  assert.equal(provider.homepage, "https://www.youtube.com/");
  assert.equal(provider.accent, "#d90000");
  assert.equal("aliases" in provider, false);
  assert.equal(findSiteSearches("my video", [provider])[0], provider);
  assert.equal(findSiteSearches("youtube", [provider])[0], provider);
  assert.equal(describeSiteSearchEngine({ ...engine, hidden: true }), null);
  assert.equal(
    describeSiteSearchEngine({ ...engine, hidden: true }, true).domain,
    "youtube.com"
  );
});

test("unsupported and invalid engines are excluded", () => {
  const engine = {
    id: "custom",
    name: "Example",
    getSubmission: () => ({
      uri: { spec: "https://search.example.org/search" },
    }),
  };
  for (const spec of [
    "https://search.example.org/search",
    "https://github.com/search?q=",
    "https://youtube.com.example.org/search",
    "https://music.youtube.com/search",
    "javascript:alert(1)",
    "file:///tmp/search",
    "invalid",
  ]) {
    assert.equal(
      describeSiteSearchEngine({
        ...engine,
        getSubmission: () => ({ uri: { spec } }),
      }),
      null
    );
  }
  assert.equal(
    describeSiteSearchEngine({
      ...engine,
      getSubmission: () => {
        throw Error("removed");
      },
    }),
    null
  );
});
